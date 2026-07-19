'use strict';

const { app, ipcMain, Tray, Menu, shell, dialog, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

// Shared %APPDATA%\VoiceLatch between dev and packaged builds.
// VOICELATCH_USERDATA overrides for hermetic E2E test runs.
// One-time migration: the app was previously named VoxFlow — adopt its data
// (settings incl. encrypted AI key, history, downloaded models) on first boot.
// rename() is instant when the old app is stopped; if it still runs (locked
// log), fall back to copying the store files, which are never held open.
(() => {
  if (process.env.VOICELATCH_USERDATA) return;
  const appData = app.getPath('appData');
  const oldDir = path.join(appData, 'VoxFlow');
  const newDir = path.join(appData, 'VoiceLatch');
  if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return;
  try {
    fs.renameSync(oldDir, newDir);
  } catch (_) {
    try {
      fs.mkdirSync(newDir, { recursive: true });
      for (const f of ['settings.json', 'history.json', 'dictionary.json']) {
        try { fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f)); } catch (_) {}
      }
      try { fs.cpSync(path.join(oldDir, 'models'), path.join(newDir, 'models'), { recursive: true }); } catch (_) {}
    } catch (_) { /* fresh start — never block boot on migration */ }
  }
})();
app.setPath('userData',
  process.env.VOICELATCH_USERDATA || path.join(app.getPath('appData'), 'VoiceLatch'));

const log = require('./log');
const { resolveAll } = require('./paths');
const { Store } = require('./store');
const { ModelManager, LANGUAGES } = require('./models');
const { Transcriber } = require('./transcriber');
const { Hotkeys } = require('./hotkeys');
const { Injector } = require('./injector');
const { transition } = require('./statemachine');
const { encodeWav } = require('./wav');
const postprocess = require('./postprocess');
const aiedit = require('./aiedit');
const windows = require('./windows');

const SELFTEST = process.argv.includes('--selftest');

if (!app.requestSingleInstanceLock()) {
  if (SELFTEST) {
    // A selftest that couldn't even start must NEVER read as green.
    // eslint-disable-next-line no-console
    console.error('selftest: another VoiceLatch instance holds the lock — close it first');
    process.exit(3);
  }
  app.quit();
} else {
  main();
}

function main() {
  const ctx = {
    paths: null,
    store: null,
    models: null,
    transcriber: null,
    hotkeys: null,
    injector: null,
    overlay: null,
    dashboard: null,
    tray: null,
    state: 'idle',
    gen: 0,
    session: null,        // { gen, startTs, target }
    flashTimer: null,
    maxTimer: null,
    warnTimer: null,
    quitting: false,
    overlayReady: null,   // promise
    dashboardReady: null,
  };

  app.on('second-instance', () => showDashboard(ctx));

  app.whenReady().then(() => boot(ctx).catch((e) => {
    log.error('boot failed', e);
    dialog.showErrorBox('VoiceLatch failed to start', String(e && e.message || e));
    app.exit(1);
  }));

  app.on('window-all-closed', (e) => { /* tray app — keep running */ });

  app.on('before-quit', () => { ctx.quitting = true; });

  process.on('uncaughtException', (e) => {
    log.error('uncaught', e);
    if (SELFTEST) app.exit(1);
  });
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
}

async function boot(ctx) {
  const userData = app.getPath('userData');
  log.init(path.join(userData, 'logs'));
  log.info('--- VoiceLatch starting', app.getVersion(), 'packaged:', app.isPackaged);

  ctx.paths = resolveAll(app);
  ctx.store = new Store(userData);
  ctx.models = new ModelManager(ctx.paths);
  ctx.transcriber = new Transcriber(ctx.paths);
  ctx.hotkeys = new Hotkeys();
  ctx.injector = new Injector(ctx.paths.injectorExe, ctx.hotkeys);

  Menu.setApplicationMenu(null);

  // Login-item state can drift from the setting (startup cleaners, reinstall,
  // toggles flipped in unpackaged dev runs are no-ops, hand-edited settings) —
  // reconcile at every boot so the stored preference is always the truth.
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: ctx.store.settings.launchAtLogin,
      args: ['--hidden'],
    });
  }

  // --- windows (factories self-re-register the crash guard, so the Nth
  // renderer crash recovers exactly like the first)
  makeOverlay(ctx);
  makeDashboard(ctx);

  // --- tray
  createTray(ctx);

  // --- global hook
  ctx.hotkeys.init();
  applyHotkeySettings(ctx);
  ctx.hotkeys.start();
  ctx.hotkeys.on('hotkey-down', () => dispatch(ctx, 'HOTKEY_DOWN'));
  ctx.hotkeys.on('hotkey-up', () => dispatch(ctx, 'HOTKEY_UP'));
  ctx.hotkeys.on('esc', () => {
    if (ctx.state !== 'idle') dispatch(ctx, 'ESC');
  });
  ctx.hotkeys.on('blocked', () => dispatch(ctx, 'BLOCKED'));

  // --- engine (background warm-up; failures surface on first use)
  ctx.transcriber.onEngineChange = (engine) => pushDash(ctx, 'engine:status', { engine });
  configureTranscriber(ctx);
  ctx.transcriber.ensure().then(
    (engine) => log.info('engine ready:', engine),
    (e) => log.warn('engine warm-up failed:', e.message)
  );

  // --- IPC
  registerIpc(ctx);

  // --- quit ordering (review delta #6)
  app.on('before-quit', () => {
    try { ctx.hotkeys.stop(); } catch (_) {}
    try { ctx.transcriber.shutdown(); } catch (_) {}
    try { ctx.store.flush(); } catch (_) {}
  });

  await ctx.overlayReady;
  log.info('overlay ready');

  if (SELFTEST) {
    const { runSelftest } = require('./selftest');
    const code = await runSelftest(ctx);
    app.exit(code);
    return;
  }

  // First run: open the dashboard so the hotkey is discoverable.
  if (!ctx.store.settings.firstRunDone) showDashboard(ctx);
}

function waitLoad(win) {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
  });
}

function makeOverlay(ctx) {
  const old = ctx.overlay;
  ctx.overlay = windows.createOverlay();
  ctx.overlayReady = waitLoad(ctx.overlay);
  windows.guardRenderer(ctx.overlay, 'overlay', () => {
    makeOverlay(ctx);
    forceIdle(ctx, 'overlay renderer restarted');
  });
  if (old && !old.isDestroyed()) old.destroy();
}

function makeDashboard(ctx) {
  const old = ctx.dashboard;
  const wasVisible = !!old && !old.isDestroyed() && old.isVisible();
  ctx.dashboard = windows.createDashboard();
  ctx.dashboardReady = waitLoad(ctx.dashboard);
  ctx.dashboard.on('close', (e) => {
    if (!ctx.quitting) { e.preventDefault(); ctx.dashboard.hide(); }
  });
  // A hidden dashboard must never keep a hotkey-capture armed (else the next
  // key typed anywhere in Windows silently becomes the new hotkey).
  ctx.dashboard.on('hide', () => ctx.hotkeys && ctx.hotkeys.cancelCapture());
  // Pushes are skipped while hidden — refresh whatever page is open on show.
  ctx.dashboard.on('show', () => pushDash(ctx, 'history:changed', {}));
  windows.guardRenderer(ctx.dashboard, 'dashboard', () => makeDashboard(ctx));
  if (old && !old.isDestroyed()) old.destroy();
  if (wasVisible) ctx.dashboardReady.then(() => alive(ctx.dashboard) && ctx.dashboard.show());
}

// ---------------------------------------------------------------- state machine
function dispatch(ctx, event, payload) {
  const res = transition(ctx.state, event, { mode: ctx.store.settings.hotkeyMode });
  if (!res.next) return;
  const prev = ctx.state;
  ctx.state = res.next;
  if (prev !== res.next) log.info(`state ${prev} → ${res.next} (${event})`);
  for (const action of res.actions) {
    try {
      ACTIONS[action](ctx, payload);
    } catch (e) {
      log.error(`action ${action} failed`, e);
      forceIdle(ctx, e.message);
    }
  }
}

function forceIdle(ctx, why) {
  log.warn('forcing idle:', why);
  ctx.gen++;
  clearTimers(ctx);
  ctx.state = 'idle';
  traySetRec(ctx, false);
  overlaySend(ctx, 'rec:stop', { discard: true }); // release the mic if recording
  if (alive(ctx.overlay)) ctx.overlay.hide();
}

function clearTimers(ctx) {
  for (const t of ['flashTimer', 'maxTimer', 'warnTimer']) {
    clearTimeout(ctx[t]);
    ctx[t] = null;
  }
}

function alive(win) { return win && !win.isDestroyed(); }

function overlaySend(ctx, ch, data) {
  if (alive(ctx.overlay)) ctx.overlay.webContents.send(ch, data);
}

function pushDash(ctx, ch, data) {
  if (!alive(ctx.dashboard)) return;
  // History refreshes are wasted work while hidden (stats over the full store
  // per dictation); the dashboard 'show' handler re-syncs on reopen.
  if (ch === 'history:changed' && !ctx.dashboard.isVisible()) return;
  ctx.dashboard.webContents.send(ch, data);
}

const ACTIONS = {
  startRec(ctx) {
    if (!alive(ctx.overlay) || ctx.overlay.webContents.isLoading()) {
      forceIdle(ctx, 'overlay renderer not ready yet');
      return;
    }
    clearTimeout(ctx.flashTimer);
    const s = ctx.store.settings;
    ctx.gen++;
    ctx.session = { gen: ctx.gen, startTs: Date.now(), targetPromise: null };
    windows.showOverlay(ctx.overlay);
    traySetRec(ctx, true);
    // Pre-warm while the user is still speaking: after an idle unload this
    // hides the 1–2 s model re-load inside the recording itself. Single-flight
    // queue in the transcriber makes it a no-op when already warm.
    ctx.transcriber.ensure().catch(() => {});
    overlaySend(ctx, 'ui:state', { state: 'listening' });
    overlaySend(ctx, 'rec:start', {
      gen: ctx.gen,
      deviceId: s.micDeviceId,
      sounds: s.sounds,
      autoStop: {
        enabled: s.hotkeyMode === 'toggle' && !!s.autoStopSilence,
        silenceMs: 2000,                 // pause length that finishes the take
        speechRms: s.silenceRms * 2.5,   // level that counts as speech
        leadMs: 15000,                   // give up if nothing was ever said
      },
    });
    const warnAt = s.maxRecordMs - 30000;
    if (warnAt > 5000) {
      ctx.warnTimer = setTimeout(() => {
        overlaySend(ctx, 'ui:state', { state: 'listening', detail: 'auto-stop soon' });
      }, warnAt);
    }
    ctx.maxTimer = setTimeout(() => dispatch(ctx, 'MAX_TIME'), s.maxRecordMs);
  },

  stopRec(ctx) {
    clearTimers(ctx);
    traySetRec(ctx, false);
    overlaySend(ctx, 'ui:state', { state: 'processing' });
    overlaySend(ctx, 'rec:stop', { discard: false });
    // Capture the injection target NOW — if focus changes while we transcribe,
    // we refuse to type into the wrong window. Stored as a promise so a fast
    // transcription AWAITS the capture instead of racing past it.
    ctx.session.targetPromise = ctx.injector.fginfo().catch(() => null);
  },

  cancelRec(ctx) {
    clearTimers(ctx);
    traySetRec(ctx, false);
    overlaySend(ctx, 'rec:stop', { discard: true });
    ctx.gen++;
  },

  abandon(ctx) {
    clearTimers(ctx);
    ctx.gen++; // in-flight transcription completes into the void
  },

  transcribe(ctx, payload) {
    runTranscription(ctx, payload).catch((e) => {
      log.error('transcription pipeline', e);
      if (payload && payload.gen === ctx.gen) dispatch(ctx, 'FAIL', { message: e.message });
    });
  },

  inject(ctx, payload) {
    runInjection(ctx, payload).catch((e) => {
      log.error('injection pipeline', e);
      dispatch(ctx, 'FAIL', { message: e.message });
    });
  },

  flashResult(ctx, payload) {
    const p = payload || {};
    let text; let state = 'success'; let ms = 1500;
    if (p.status === 'copied') {
      state = 'copied';
      ms = 3200;
      text =
        p.reason === 'window-changed' ? 'Window changed — copied, press Ctrl+V' :
        p.reason === 'elevated' ? 'Admin window — copied, press Ctrl+V' :
        'Copied — press Ctrl+V';
    } else {
      text = `${p.words} word${p.words === 1 ? '' : 's'}`;
    }
    overlaySend(ctx, 'ui:state', { state, detail: text });
    ctx.flashTimer = setTimeout(() => dispatch(ctx, 'FLASH_END'), ms);
  },

  flashNoSpeech(ctx) {
    overlaySend(ctx, 'ui:state', { state: 'nospeech', detail: 'No speech detected' });
    ctx.flashTimer = setTimeout(() => dispatch(ctx, 'FLASH_END'), 1600);
  },

  flashError(ctx, payload) {
    const msg = (payload && payload.message) || 'Something went wrong';
    overlaySend(ctx, 'ui:state', { state: 'error', detail: msg.slice(0, 80) });
    ctx.flashTimer = setTimeout(() => dispatch(ctx, 'FLASH_END'), 2600);
  },

  flashDisabled(ctx) {
    windows.showOverlay(ctx.overlay);
    overlaySend(ctx, 'ui:state', { state: 'nospeech', detail: 'Dictation is off' });
    ctx.flashTimer = setTimeout(() => dispatch(ctx, 'FLASH_END'), 1400);
  },

  pulseBusy(ctx) {
    overlaySend(ctx, 'ui:state', { state: 'processing', pulse: true });
  },

  hideOverlay(ctx) {
    if (alive(ctx.overlay)) ctx.overlay.hide();
  },
};

async function runTranscription(ctx, payload) {
  const s = ctx.store.settings;
  const gen = payload.gen;
  if (gen !== ctx.gen) return;

  if (payload.durationMs < s.minRecordMs) {
    dispatch(ctx, 'REC_TOO_SHORT');
    return;
  }
  if (payload.rms < s.silenceRms) {
    log.info('silence gate: rms', payload.rms.toFixed(5));
    dispatch(ctx, 'TRANSCRIBED_EMPTY');
    return;
  }

  // The wav stays in memory on the hot path (server engine posts the buffer
  // directly — no temp-file write+read, no AV scan). Disk only on failure,
  // to keep the last-failed.wav debugging artifact.
  const pcm = new Float32Array(payload.pcm);
  const wav = encodeWav(pcm, payload.sampleRate || 16000);

  let result;
  try {
    result = await ctx.transcriber.transcribe(wav, payload.durationMs);
  } catch (e) {
    try { fs.writeFileSync(path.join(ctx.paths.tmpDir, 'last-failed.wav'), wav); } catch (_) {}
    if (gen !== ctx.gen) return;
    ctx.store.addHistory({
      text: '', durationMs: payload.durationMs, words: 0,
      status: 'failed', engine: ctx.transcriber.engine,
    });
    pushDash(ctx, 'history:changed', {});
    dispatch(ctx, 'FAIL', { message: `Transcription failed — ${e.message.slice(0, 60)}` });
    return;
  }
  if (gen !== ctx.gen) { log.info('stale transcription dropped'); return; }

  const cleaned = postprocess.process(result.text, {
    removeFillers: s.removeFillers,
    spokenCommands: s.spokenCommands,
    replacements: ctx.store.dictionary.replacements,
    rms: payload.rms,
    silenceRms: s.silenceRms,
  });

  if (result.noSpeech || !cleaned) {
    dispatch(ctx, 'TRANSCRIBED_EMPTY');
    return;
  }

  // Optional AI edits — strictly fail-open: a cloud error, timeout, or junk
  // response injects the raw transcript instead. A dictation is never lost
  // or blocked on the network.
  let finalText = cleaned;
  let aiApplied = false;
  // Sub-3-word utterances ("yes", "send it") skip the AI round-trip: nothing
  // to polish, and the network hop would double their latency.
  if (s.aiEdits && s.aiApiKey && postprocess.countWords(cleaned) >= 3) {
    overlaySend(ctx, 'ui:state', { state: 'processing', detail: 'AI polish…' });
    const ai = await aiedit.enhance(cleaned, s);
    if (gen !== ctx.gen) { log.info('stale AI edit dropped'); return; }
    if (ai.ok) { finalText = ai.text; aiApplied = true; }
    else log.warn('AI edit failed open — using raw transcript:', ai.error);
    log.info(`ai edit ${ai.ok ? 'applied' : 'skipped'} (${ai.ms}ms)`);
  }

  dispatch(ctx, 'TRANSCRIBED_TEXT', {
    gen,
    text: finalText,
    ai: aiApplied,
    durationMs: payload.durationMs,
    engine: result.engine,
    procMs: result.ms,
  });
}

async function runInjection(ctx, payload) {
  const s = ctx.store.settings;
  if (payload.gen !== ctx.gen) return;
  let target = null;
  if (ctx.session && ctx.session.gen === payload.gen && ctx.session.targetPromise) {
    target = await ctx.session.targetPromise;
  }
  if (payload.gen !== ctx.gen) return;
  const res = await ctx.injector.inject(payload.text, s, target);
  if (payload.gen !== ctx.gen) return;

  const words = postprocess.countWords(payload.text);
  const wpm = payload.durationMs > 0 ? Math.round(words / (payload.durationMs / 60000)) : 0;
  ctx.store.addHistory({
    text: payload.text,
    durationMs: payload.durationMs,
    words,
    wpm,
    app: target ? `${target.proc}` : '',
    engine: payload.engine,
    procMs: payload.procMs,
    status: res.status === 'injected' ? 'injected' : 'copied',
    ai: !!payload.ai,
  });
  pushDash(ctx, 'history:changed', {});

  if (!ctx.store.settings.firstRunDone) {
    ctx.store.updateSettings({ firstRunDone: true });
    pushDash(ctx, 'onboarding:done', {});
  }
  dispatch(ctx, 'INJECT_DONE', { ...res, words });
}

// ---------------------------------------------------------------- tray & misc
function trayIcon(ctx, rec) {
  return path.join(ctx.paths.appRoot, 'assets', 'icons', rec ? 'tray-rec.ico' : 'tray.ico');
}

function createTray(ctx) {
  ctx.tray = new Tray(trayIcon(ctx, false));
  updateTray(ctx);
  ctx.tray.on('double-click', () => showDashboard(ctx));
}

function updateTray(ctx) {
  const s = ctx.store.settings;
  ctx.tray.setToolTip(`VoiceLatch — hold ${s.hotkey.name} to dictate`);
  ctx.tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => showDashboard(ctx) },
    { type: 'separator' },
    {
      label: 'Enable dictation', type: 'checkbox', checked: s.enabled,
      click: (item) => applySettings(ctx, { enabled: item.checked }),
    },
    {
      label: 'Start with Windows', type: 'checkbox', checked: s.launchAtLogin,
      click: (item) => applySettings(ctx, { launchAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit VoiceLatch', click: () => { ctx.quitting = true; app.quit(); } },
  ]));
}

function traySetRec(ctx, rec) {
  try { ctx.tray.setImage(trayIcon(ctx, rec)); } catch (_) {}
}

function showDashboard(ctx) {
  if (!alive(ctx.dashboard)) return;
  ctx.dashboardReady.then(() => {
    ctx.dashboard.show();
    ctx.dashboard.focus();
  });
}

function applyHotkeySettings(ctx) {
  const s = ctx.store.settings;
  ctx.hotkeys.setConfig({ keycode: s.hotkey.keycode, enabled: s.enabled });
}

function configureTranscriber(ctx) {
  const s = ctx.store.settings;
  // Resolve to a model that actually exists on THIS machine — after an
  // upgrade changes the bundled model (or files are deleted), we fall back
  // instead of failing the next dictation.
  const resolved = ctx.models.resolveActive(s.model);
  if (resolved && resolved.changed) {
    log.warn(`model '${s.model}' not available — switching to '${resolved.id}'`);
    ctx.store.updateSettings({ model: resolved.id });
    pushDash(ctx, 'settings:changed', ctx.store.settings);
  }
  const prompt = ctx.store.dictionary.boostWords.join(', ');
  ctx.transcriber.configure({
    modelPath: resolved ? resolved.path : null,
    language: ctx.store.settings.language,
    prompt,
    idleUnloadMs: ctx.store.settings.idleUnload ? 10 * 60 * 1000 : 0,
  });
}

function applySettings(ctx, patch) {
  const before = ctx.store.settings;
  const s = ctx.store.updateSettings(patch);
  applyHotkeySettings(ctx);
  if (patch.model || patch.language) configureTranscriber(ctx);
  if ('launchAtLogin' in patch && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, args: ['--hidden'] });
  }
  if ('enabled' in patch && !s.enabled && ctx.state !== 'idle') forceIdle(ctx, 'disabled');
  if (patch.hotkey && before.hotkey.keycode !== s.hotkey.keycode) {
    log.info('hotkey rebound to', s.hotkey.name, s.hotkey.keycode);
  }
  updateTray(ctx);
  pushDash(ctx, 'settings:changed', s);
  return s;
}

// ---------------------------------------------------------------- IPC
function registerIpc(ctx) {
  // overlay
  ipcMain.on('rec:done', (_e, payload) => {
    if (!payload || payload.gen !== ctx.gen) return;
    dispatch(ctx, 'REC_DONE', payload);
  });
  ipcMain.on('rec:error', (_e, payload) => {
    log.warn('rec:error', payload && payload.message);
    if (ctx.state === 'listening' || ctx.state === 'processing') {
      dispatch(ctx, 'REC_ERROR', {
        message: friendlyMicError(payload && payload.message),
      });
    }
  });
  ipcMain.on('rec:autostop', (_e, payload) => {
    if (!payload || payload.gen !== ctx.gen) return;
    log.info('auto-stop: silence detected');
    dispatch(ctx, 'AUTO_STOP');
  });

  // dashboard
  ipcMain.handle('settings:get', () => ctx.store.settings);
  ipcMain.handle('settings:set', (_e, patch) => applySettings(ctx, patch || {}));
  ipcMain.handle('dict:get', () => ctx.store.dictionary);
  ipcMain.handle('dict:set', (_e, dict) => {
    const d = ctx.store.setDictionary(dict || {});
    configureTranscriber(ctx);
    return d;
  });
  ipcMain.handle('history:list', (_e, q) => {
    const query = (q || '').toLowerCase().trim();
    if (!query) return ctx.store.history.slice(0, 300);
    return ctx.store.history
      .filter((h) => h.text.toLowerCase().includes(query) || h.app.toLowerCase().includes(query))
      .slice(0, 300);
  });
  ipcMain.handle('history:delete', (_e, id) => { ctx.store.deleteHistory(id); return true; });
  ipcMain.handle('history:clear', () => { ctx.store.clearHistory(); return true; });
  ipcMain.handle('history:copy', (_e, id) => {
    const h = ctx.store.history.find((x) => x.id === id);
    if (h) clipboard.writeText(h.text);
    return !!h;
  });
  ipcMain.handle('history:export', async () => {
    if (ctx.store.history.length === 0) return { ok: false, error: 'History is empty' };
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(ctx.dashboard, {
      title: 'Export dictation history',
      defaultPath: `VoiceLatch-history-${stamp}.txt`,
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'CSV (spreadsheet)', extensions: ['csv'] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const { historyToTxt, historyToCsv } = require('./store');
    const body = filePath.toLowerCase().endsWith('.csv')
      ? historyToCsv(ctx.store.history)
      : historyToTxt(ctx.store.history);
    fs.writeFileSync(filePath, '﻿' + body, 'utf8'); // BOM: Excel-safe UTF-8
    log.info('history exported:', filePath, `${ctx.store.history.length} entries`);
    return { ok: true, path: filePath, count: ctx.store.history.length };
  });
  ipcMain.handle('stats:get', () => ctx.store.stats());
  ipcMain.handle('models:list', () => ctx.models.list(ctx.store.settings.model));
  ipcMain.handle('models:download', async (_e, id) => {
    try {
      await ctx.models.download(id, (p) => pushDash(ctx, 'models:progress', p));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('models:cancel', (_e, id) => { ctx.models.cancel(id); return true; });
  ipcMain.handle('models:activate', async (_e, id) => {
    const m = ctx.models.get(id);
    if (!m) return { ok: false, error: 'unknown model' };
    const p = ctx.paths.findModel(m.file);
    if (!p) return { ok: false, error: 'not downloaded' };
    if (!ctx.models.validateModelFile(p, m)) return { ok: false, error: 'model file corrupt — re-download' };
    applySettings(ctx, { model: id });
    try {
      const engine = await ctx.transcriber.ensure();
      pushDash(ctx, 'engine:status', { engine });
      return { ok: true, engine };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('languages:list', () => LANGUAGES);
  ipcMain.handle('hotkey:capture', () => new Promise((resolve) => {
    ctx.hotkeys.captureNext((key) => {
      if (key) applySettings(ctx, { hotkey: key });
      resolve(key); // null = cancelled with Esc
    });
  }));
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    engine: ctx.transcriber.engine,
    packaged: app.isPackaged,
    logsDir: ctx.paths.logsDir,
    userDataDir: ctx.paths.userDataDir,
    whisper: ctx.paths.whisperCli,
    injector: ctx.paths.injectorExe,
    firstRunDone: ctx.store.settings.firstRunDone,
    hotkeyName: ctx.store.settings.hotkey.name,
  }));
  ipcMain.handle('ai:meta', () => ({ providers: aiedit.PROVIDERS, styles: aiedit.STYLES }));
  ipcMain.handle('ai:test', () => aiedit.verify(ctx.store.settings));
  // Fixed, provider-defined URL only — the renderer can't open arbitrary links.
  ipcMain.handle('ai:keyUrl', () => {
    const p = aiedit.PROVIDERS[ctx.store.settings.aiProvider] || aiedit.PROVIDERS.groq;
    shell.openExternal(p.keyUrl || aiedit.PROVIDERS.groq.keyUrl);
    return true;
  });
  ipcMain.handle('logs:open', () => { shell.openPath(ctx.paths.logsDir); return true; });
  ipcMain.handle('dashboard:hide', () => { if (alive(ctx.dashboard)) ctx.dashboard.hide(); return true; });
}

function friendlyMicError(raw) {
  const m = String(raw || '');
  if (/NotAllowedError|Permission/i.test(m)) {
    return 'Mic blocked — Windows Settings → Privacy → Microphone';
  }
  if (/NotFoundError|NotReadable/i.test(m)) return 'No microphone found or it is in use';
  if (/ended|lost/i.test(m)) return 'Microphone disconnected';
  return `Mic error — ${m.slice(0, 50)}`;
}

module.exports = { dispatch };

'use strict';

// In-app smoke harness: `electron . --selftest [--selftest-wav <path>] [--selftest-out <dir>]`
// Exercises the REAL app: hook, tray, windows, real mic capture, engine, injector.
// Writes selftest-artifacts/report.json + screenshots. Exit 0 = all green.

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const log = require('./log');
const { encodeWav } = require('./wav');
const windows = require('./windows');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function runSelftest(ctx) {
  const outDir = argValue('--selftest-out') ||
    path.join(process.cwd(), 'selftest-artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    ok: true,
    appVersion: require('electron').app.getVersion(),
    electron: process.versions.electron,
    packaged: require('electron').app.isPackaged,
    startedAt: new Date().toISOString(),
    steps: [],
  };
  const t0 = Date.now();

  async function step(name, fn) {
    const s = Date.now();
    try {
      const detail = await fn();
      report.steps.push({ name, ok: true, ms: Date.now() - s, detail: detail == null ? '' : detail });
      log.info('[selftest] PASS', name);
    } catch (e) {
      report.steps.push({ name, ok: false, ms: Date.now() - s, detail: String(e && e.message || e) });
      report.ok = false;
      log.error('[selftest] FAIL', name, e && e.message);
    }
  }

  await step('paths: whisper-cli resolved', () => {
    if (!ctx.paths.whisperCli) throw new Error(`not found in ${ctx.paths.binRoots.join(' ; ')} — run: npm run setup`);
    return ctx.paths.whisperCli;
  });
  await step('paths: whisper-server resolved', () => {
    if (!ctx.paths.whisperServer) throw new Error('whisper-server.exe missing (cli fallback would still work)');
    return ctx.paths.whisperServer;
  });
  await step('paths: injector resolved', () => {
    if (!ctx.paths.injectorExe) throw new Error('injector.exe missing — run: npm run setup');
    return ctx.paths.injectorExe;
  });
  await step('paths: active model resolved', () => {
    const m = ctx.models.get(ctx.store.settings.model);
    const p = m && ctx.paths.findModel(m.file);
    if (!p) throw new Error(`model ${ctx.store.settings.model} not found`);
    if (!ctx.models.validateModelFile(p, m)) throw new Error('model file too small — corrupt download?');
    return p;
  });
  await step('store: settings round-trip', () => {
    const v = `t-${Date.now()}`;
    ctx.store.updateSettings({ _selftest: v });
    if (ctx.store.settings._selftest !== v) throw new Error('setting did not persist in memory');
    delete ctx.store.settings._selftest;
    return 'ok';
  });
  await step('hook: uiohook active + CtrlRight code', () => {
    if (!ctx.hotkeys.started) throw new Error('hook not started');
    const code = ctx.hotkeys.UiohookKey.CtrlRight;
    return `CtrlRight=${code} configured=${ctx.store.settings.hotkey.keycode}`;
  });
  await step('tray: created', () => {
    if (!ctx.tray || ctx.tray.isDestroyed()) throw new Error('tray missing');
    return 'ok';
  });
  await step('windows: overlay + dashboard loaded', async () => {
    await ctx.overlayReady;
    await ctx.dashboardReady;
    return 'ok';
  });

  await step('mic: 1s real capture → valid 16 kHz PCM', async () => {
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mic capture timeout (10 s)')), 10000);
      ipcMain.once('selftest:mic-result', (_e, r) => { clearTimeout(timer); resolve(r); });
      ctx.overlay.webContents.send('selftest:mic', { ms: 1000, deviceId: ctx.store.settings.micDeviceId });
    });
    if (!res.ok) throw new Error(res.error || 'capture failed');
    // Worklet startup eats a slice of the 1 s window — require ≥0.5 s of audio.
    const expected = 16000;
    if (res.samples < expected * 0.5 || res.samples > expected * 1.4) {
      throw new Error(`sample count off: ${res.samples} (expected ≈${expected})`);
    }
    const wav = encodeWav(new Float32Array(res.samples).fill(0), 16000);
    if (wav.length !== 44 + res.samples * 2) throw new Error('wav encoder length mismatch');
    return `samples=${res.samples} rms=${res.rms.toFixed(5)} (quiet room → low rms is normal)`;
  });

  await step('engine: warm-up', async () => {
    const engine = await ctx.transcriber.ensure();
    return `engine=${engine}`;
  });

  const wavArg = argValue('--selftest-wav');
  if (wavArg && fs.existsSync(wavArg)) {
    await step('engine: transcribe reference wav', async () => {
      const r = await ctx.transcriber.transcribe(wavArg, 7000);
      if (!r.text || r.text.trim().length < 5) throw new Error(`empty transcript (engine=${r.engine})`);
      report.referenceTranscript = r.text.trim();
      return `engine=${r.engine} ms=${r.ms} text="${r.text.trim().slice(0, 80)}"`;
    });
  }

  await step('injector: fginfo parses', async () => {
    const info = await ctx.injector.fginfo();
    if (!info || !info.hwnd) throw new Error('fginfo unparseable');
    return `fg=${info.proc} elevated=${info.elevated}`;
  });

  await step('screenshots: overlay states + dashboard', async () => {
    windows.showOverlay(ctx.overlay);
    ctx.overlay.webContents.send('ui:state', { state: 'listening', demo: true });
    await sleep(700);
    await snap(ctx.overlay, path.join(outDir, 'overlay-listening.png'));
    ctx.overlay.webContents.send('ui:state', { state: 'success', detail: '12 words' });
    await sleep(250);
    await snap(ctx.overlay, path.join(outDir, 'overlay-success.png'));
    ctx.overlay.hide();

    const dash = ctx.dashboard;
    const pos = dash.getPosition();
    dash.setPosition(-4000, -4000);       // paint without disturbing the user
    dash.showInactive();
    await sleep(900);
    await snap(dash, path.join(outDir, 'dashboard.png'));
    dash.hide();
    dash.setPosition(pos[0], pos[1]);
    return 'saved 3 screenshots';
  });

  report.ms = Date.now() - t0;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  log.info('[selftest]', report.ok ? 'ALL GREEN' : 'FAILURES', JSON.stringify(report.steps.map(s => `${s.ok ? '+' : 'X'}${s.name}`)));
  return report.ok ? 0 : 1;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function snap(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
}

module.exports = { runSelftest };

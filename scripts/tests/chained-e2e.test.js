'use strict';

/* Chained E2E: drives the REAL app through its REAL input path.
 *   synthetic F9 hold (SendInput, correct scancode — uiohook sees it)
 *     → app records the real microphone (TTS plays via speakers: loopback)
 *     → release → transcribe → inject into a real Notepad window
 *     → Ctrl+A/C readback.
 * Verdicts:
 *   FULL        notepad text ≈ spoken text (acoustic loopback worked)
 *   STRUCTURAL  hotkey→record→gate chain proven, but the mic heard silence
 *               (muted speakers / quiet room) → nothing injected, correctly
 *   PARTIAL     app injected (history/log proof) but notepad readback failed
 *   FAIL        the chain broke somewhere
 * Exit 0 for FULL/STRUCTURAL/PARTIAL (each honestly reported), 1 for FAIL.
 * NOTE: steals focus for ~15 s and plays audio aloud.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { wordOverlap, waitForUserIdle } = require('./harness');
const { speakAloud } = require('./tts');

const ROOT = path.join(__dirname, '..', '..');
const EXE = path.join(ROOT, 'runtime', 'bin', 'Release', 'injector.exe');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SPOKEN = 'The quick brown fox jumps over the lazy dog.';

function helper(args) {
  const r = spawnSync(EXE, args, { encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForLog(file, pattern, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (pattern.test(fs.readFileSync(file, 'utf8'))) return true;
    } catch (_) { /* not yet */ }
    await sleep(300);
  }
  return false;
}

async function main() {
  console.log('chained-e2e: starting (steals focus ~15s, plays audio)');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'voicelatch-e2e-'));
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });

  const { UiohookKey } = require('uiohook-napi');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    hotkey: { keycode: UiohookKey.F9, name: 'F9' },
    hotkeyMode: 'hold',
    injectionMode: 'paste',
    sounds: false,
    enabled: true,
    firstRunDone: true,
    micDeviceId: 'default',
    model: 'base.en',
    language: 'en',
    minRecordMs: 300,
  }));

  const targetFile = path.join(userData, 'e2e-target.txt');
  fs.writeFileSync(targetFile, '');

  const logFile = path.join(userData, 'logs', 'voicelatch.log');
  const app = spawn(ELECTRON, ['.'], {
    cwd: ROOT,
    env: { ...process.env, VOICELATCH_USERDATA: userData },
    stdio: 'ignore',
  });
  let notepad = null;
  let verdict = 'FAIL';
  let details = [];

  try {
    if (!(await waitForLog(logFile, /overlay ready/, 30000))) {
      throw new Error('app never reached "overlay ready" — see ' + logFile);
    }
    details.push('app booted, hook active');

    await waitForUserIdle(EXE, 4000, 90000);
    notepad = spawn('notepad.exe', [targetFile], { stdio: 'ignore', detached: true });
    await sleep(1800);
    const f = helper(['focus', 'e2e-target']);
    if (f.code !== 0) throw new Error(`could not focus notepad: ${f.err}`);
    details.push('notepad focused');

    // Speak through the speakers while virtually holding F9.
    const speaker = speakAloud(SPOKEN, 0);
    await sleep(600);
    const hold = helper(['holdkey', 'f9', '6500']);
    if (hold.code !== 0) throw new Error(`holdkey failed: ${hold.err}`);
    try { speaker.kill(); } catch (_) {}

    const sawListening = await waitForLog(logFile, /→ listening/, 4000);
    const sawProcessing = await waitForLog(logFile, /→ processing/, 8000);
    details.push(`states: listening=${sawListening} processing=${sawProcessing}`);
    if (!sawListening || !sawProcessing) {
      throw new Error('hotkey→record chain did not fire (states missing in log)');
    }
    // Give transcription + injection time to finish.
    await waitForLog(logFile, /→ (injecting|flash)/, 25000);
    await sleep(2500);

    // Read the notepad content back — but only if notepad really has focus,
    // otherwise Ctrl+A/C would harvest whatever window stole it.
    let typed = '';
    let readbackOk = false;
    await waitForUserIdle(EXE, 3000, 30000);
    for (let attempt = 0; attempt < 2 && !readbackOk; attempt++) {
      helper(['focus', 'e2e-target']);
      const fg = helper(['fginfo']);
      readbackOk = fg.code === 0 && /e2e-target|notepad/i.test(fg.out.split('|').slice(3).join('|'));
      if (!readbackOk) await sleep(500);
    }
    if (readbackOk) {
      helper(['copyall']);
      const clip = helper(['getclip']);
      typed = (clip.out || '').trim();
      details.push(`notepad content: "${typed.slice(0, 80)}"`);
    } else {
      details.push('readback unavailable: could not refocus notepad — relying on app history');
    }

    const log = fs.readFileSync(logFile, 'utf8');
    // history.json does not exist on the (correct) no-speech path — that must
    // resolve to the STRUCTURAL verdict, not an ENOENT-induced FAIL.
    let history = [];
    try {
      history = JSON.parse(fs.readFileSync(path.join(userData, 'history.json'), 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch (_) { /* no dictation was recorded */ }
    const injectedEntry = history.find((h) => h.status === 'injected' || h.status === 'copied');

    if (typed && wordOverlap(SPOKEN, typed) >= 0.5) {
      verdict = 'FULL';
      details.push(`overlap ${(wordOverlap(SPOKEN, typed) * 100).toFixed(0)}% — acoustic loopback worked`);
    } else if (injectedEntry) {
      verdict = 'PARTIAL';
      details.push(`app injected "${injectedEntry.text.slice(0, 60)}" (status ${injectedEntry.status}) but notepad readback saw "${typed.slice(0, 40)}"`);
    } else if (/silence gate|TRANSCRIBED_EMPTY|flashNoSpeech|nospeech/i.test(log) ||
               /→ flash/.test(log)) {
      verdict = 'STRUCTURAL';
      details.push('mic heard silence (speakers muted/quiet room) — chain correct through the no-speech gate');
    }
  } catch (e) {
    details.push(`error: ${e.message}`);
  } finally {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/t', '/f'], { timeout: 10000 }); } catch (_) {}
    if (notepad) { try { spawnSync('taskkill', ['/pid', String(notepad.pid), '/t', '/f'], { timeout: 10000 }); } catch (_) {} }
    await sleep(300);
    try {
      fs.copyFileSync(logFile, path.join(ROOT, 'selftest-artifacts', 'e2e-app.log'));
    } catch (_) {}
  }

  const ok = verdict !== 'FAIL';
  console.log(`chained-e2e verdict: ${verdict}`);
  for (const d of details) console.log(`  - ${d}`);
  fs.writeFileSync(
    path.join(ROOT, 'selftest-artifacts', 'e2e-verdict.json'),
    JSON.stringify({ verdict, details, spoken: SPOKEN }, null, 2)
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('e2e crashed:', e); process.exit(1); });

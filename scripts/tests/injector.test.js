'use strict';

/* Real keystroke-synthesis round-trips. The helper opens its own Win32
 * textbox, injects, and reads the textbox back — so a pass here proves the
 * exact SendInput path the app uses. NOTE: briefly opens a small focused
 * window per case. */

const path = require('path');
const { spawnSync } = require('child_process');
const { test, run, assert, assertEq, waitForUserIdle } = require('./harness');

const EXE = path.join(__dirname, '..', '..', 'runtime', 'bin', 'Release', 'injector.exe');

test('desktop idle gate (waits for hands-off)', async () => {
  await waitForUserIdle(EXE, 4000, 90000);
});

function helper(args, stdinText) {
  const r = spawnSync(EXE, args, {
    encoding: 'utf8',
    input: stdinText,
    timeout: 30000,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// A human typing mid-test steals focus from the round-trip window. One retry
// after the desktop re-idles turns that race into a wait instead of a failure.
async function roundTrip(args, stdinText, want) {
  for (let attempt = 0; ; attempt++) {
    const r = helper(args, stdinText);
    const got = r.out.replace(/^RESULT:/, '').replace(/\r\n/g, '\n');
    if (r.code === 0 && got === want) return { code: 0, got };
    if (attempt >= 1) return { code: r.code, got, err: r.err };
    console.log('       (round-trip disturbed — re-idling and retrying once)');
    await waitForUserIdle(EXE, 4000, 60000);
  }
}

test('fginfo: parses hwnd|elevated|proc|title', () => {
  const t0 = Date.now();
  const r = helper(['fginfo']);
  const spawnMs = Date.now() - t0;
  assertEq(r.code, 0, `exit code (err: ${r.err})`);
  const parts = r.out.split('|');
  assert(parts.length >= 4, `parts: ${r.out}`);
  assert(/^\d+$/.test(parts[0]), 'hwnd numeric');
  assert(parts[1] === '0' || parts[1] === '1', 'elevated flag');
  console.log(`       (helper spawn+query took ${spawnMs}ms)`);
});

test('typetest: punctuation + accented unicode round-trip', async () => {
  const text = 'Hello, VoiceLatch! Café naïve résumé — 100% done.';
  const r = await roundTrip(['typetest', text], null, text);
  assertEq(r.code, 0, `got=${r.got}; err=${r.err}`);
});

test('typetest: multiline via stdin becomes real Enter presses', async () => {
  const text = 'Line one.\nLine two, indeed.\nLine three!';
  const r = await roundTrip(['typetest', '-'], text, text);
  assertEq(r.code, 0, `got=${r.got}; err=${r.err}`);
});

test('typetest: 2 KB burst stays intact', async () => {
  const text = ('The rain in Spain stays mainly in the plain. ').repeat(45).trim();
  const r = await roundTrip(['typetest', '-'], text, text);
  assertEq(r.code, 0, `got=${(r.got || '').slice(0, 80)}…`);
});

test('pastetest: clipboard + Ctrl+V round-trip, clipboard restored', async () => {
  const marker = `voicelatch-prev-${Date.now()}`;
  spawnSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value '${marker}'`], { timeout: 15000 });
  const text = 'Clipboard route: fast & reliable (v1.0) — ümlauts too.';
  const r = await roundTrip(['pastetest', text], null, text);
  assertEq(r.code, 0, `got=${r.got}; err=${r.err}`);
  const clip = helper(['getclip']);
  assertEq(clip.out, marker, 'previous clipboard restored after pastetest');
});

run('injector');

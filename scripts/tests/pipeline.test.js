'use strict';

/* Chained pipeline minus the microphone: real speech WAV → transcribe →
 * post-process (with a dictionary rule) → REAL keystroke injection into a
 * Win32 textbox → read back. If this passes, everything after "audio exists"
 * is proven end-to-end. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { test, run, assert, wordOverlap, waitForUserIdle } = require('./harness');
const { synthWav } = require('./tts');
const { Transcriber } = require('../../src/main/transcriber');
const pp = require('../../src/main/postprocess');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'runtime', 'bin', 'Release');
const EXE = path.join(BIN, 'injector.exe');
const MODEL = path.join(ROOT, 'runtime', 'models', 'ggml-base.en.bin');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voicelatch-pipe-'));
const paths = {
  whisperCli: path.join(BIN, 'whisper-cli.exe'),
  whisperServer: path.join(BIN, 'whisper-server.exe'),
  binDir: BIN,
  publicDir: (() => { const p = path.join(TMP, 'public'); fs.mkdirSync(p); return p; })(),
};

const SPOKEN = 'The quick brown fox jumps over the lazy dog near the river bank.';

test('speech → text → dictionary → keystrokes → verbatim readback', async () => {
  const wav = path.join(TMP, 'pipe.wav');
  synthWav(SPOKEN, wav, 0);

  const tr = new Transcriber(paths);
  tr.configure({ modelPath: MODEL, language: 'en', prompt: '' });
  const raw = await tr.transcribe(wav, 6000);
  await tr.shutdown();
  assert(wordOverlap(SPOKEN, raw.text) >= 0.7, `bad transcript: ${raw.text}`);

  const cleaned = pp.process(raw.text, {
    removeFillers: true,
    replacements: [{ from: 'river bank', to: 'Riverbank™' }],
    rms: 0.2,
    silenceRms: 0.0045,
  });
  assert(cleaned.includes('Riverbank™'), `replacement missing: ${cleaned}`);

  let typed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForUserIdle(EXE, 4000, 90000);
    const r = spawnSync(EXE, ['typetest', '-'], { encoding: 'utf8', input: cleaned, timeout: 30000 });
    typed = (r.stdout || '').replace(/^RESULT:/, '').replace(/\r\n/g, '\n');
    if (r.status === 0 && typed === cleaned) break;
    if (attempt === 0) console.log('       (round-trip disturbed — retrying once)');
  }
  assert(typed === cleaned, `typed text differs:\n  want: ${cleaned}\n  got:  ${typed}`);
  console.log(`       final injected text: "${typed}"`);
});

run('pipeline');

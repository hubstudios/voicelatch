'use strict';

/* Failure drills: server murdered mid-session must not lose the utterance;
 * a corrupt model must produce a clear error, not a hang or crash loop. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, run, assert } = require('./harness');
const { synthWav } = require('./tts');
const { Transcriber } = require('../../src/main/transcriber');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'runtime', 'bin', 'Release');
const MODEL = path.join(ROOT, 'runtime', 'models', 'ggml-base.en.bin');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voicelatch-fail-'));
const paths = {
  whisperCli: path.join(BIN, 'whisper-cli.exe'),
  whisperServer: path.join(BIN, 'whisper-server.exe'),
  binDir: BIN,
  publicDir: (() => { const p = path.join(TMP, 'public'); fs.mkdirSync(p); return p; })(),
};

const WAV = path.join(TMP, 'probe.wav');

test('setup: probe wav + engine up', async () => {
  synthWav('Failover drill: the server is about to be killed.', WAV, 0);
  const tr = new Transcriber(paths);
  tr.configure({ modelPath: MODEL, language: 'en', prompt: '' });
  const engine = await tr.ensure();
  assert(engine === 'server', `need server engine for this drill, got ${engine}`);
  global.__tr = tr;
});

test('server killed between utterances → next utterance still transcribes', async () => {
  const tr = global.__tr;
  tr.proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  const r = await tr.transcribe(WAV, 5000);
  assert(r.text.trim().length > 10, `no text after kill: "${r.text}"`);
  console.log(`       recovered via engine=${r.engine}: "${r.text.trim().slice(0, 50)}…"`);
});

test('corrupt model → clear error, no hang', async () => {
  const corrupt = path.join(TMP, 'ggml-corrupt.bin');
  const fd = fs.openSync(MODEL, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  fs.writeFileSync(corrupt, buf); // truncated model: loads headers, then dies
  const tr = new Transcriber(paths);
  tr.configure({ modelPath: corrupt, language: 'en', prompt: '' });
  const t0 = Date.now();
  let threw = null;
  try {
    await tr.transcribe(WAV, 5000);
  } catch (e) {
    threw = e;
  }
  await tr.shutdown();
  assert(threw, 'corrupt model must raise an error');
  assert(Date.now() - t0 < 120000, 'error must arrive without a long hang');
  console.log(`       error surfaced in ${Date.now() - t0}ms: ${String(threw.message).slice(0, 90)}`);
});

test('missing model path → immediate configuration error', async () => {
  const tr = new Transcriber(paths);
  tr.configure({ modelPath: path.join(TMP, 'nope.bin'), language: 'en', prompt: '' });
  let threw = null;
  try { await tr.ensure(); } catch (e) { threw = e; }
  assert(threw && /missing/i.test(threw.message), `got: ${threw && threw.message}`);
});

process.on('exit', () => { try { global.__tr && global.__tr.shutdown(); } catch (_) {} });

run('engine-failover');

'use strict';

/* Transcription accuracy with generated ground-truth speech (Windows TTS),
 * against BOTH engines, plus silence handling and a long-clip run. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, run, assert, wordOverlap } = require('./harness');
const { synthWav } = require('./tts');
const { Transcriber } = require('../../src/main/transcriber');
const { encodeWav } = require('../../src/main/wav');
const pp = require('../../src/main/postprocess');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'runtime', 'bin', 'Release');
const MODEL = path.join(ROOT, 'runtime', 'models', 'ggml-base.en.bin');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voicelatch-acc-'));

const paths = {
  whisperCli: path.join(BIN, 'whisper-cli.exe'),
  whisperServer: path.join(BIN, 'whisper-server.exe'),
  binDir: BIN,
  publicDir: (() => { const p = path.join(TMP, 'public'); fs.mkdirSync(p); return p; })(),
};

const SENTENCES = [
  'The quick brown fox jumps over the lazy dog.',
  'Please schedule the quarterly budget review for Tuesday afternoon.',
  'Voice dictation should feel fast, private, and effortless every day.',
];

let server;

test('server engine starts (warm model)', async () => {
  server = new Transcriber(paths);
  server.configure({ modelPath: MODEL, language: 'en', prompt: '' });
  const engine = await server.ensure();
  assert(engine === 'server', `expected server engine, got ${engine}`);
});

for (let i = 0; i < SENTENCES.length; i++) {
  test(`server: sentence ${i + 1} ≥70% word overlap`, async () => {
    const wav = path.join(TMP, `s${i}.wav`);
    synthWav(SENTENCES[i], wav, 0);
    const r = await server.transcribe(wav, 6000);
    const score = wordOverlap(SENTENCES[i], r.text);
    console.log(`       [${r.engine} ${r.ms}ms] "${r.text.trim()}" (overlap ${(score * 100).toFixed(0)}%)`);
    assert(score >= 0.7, `overlap ${score} < 0.7 for "${r.text}"`);
  });
}

test('server: pure silence yields no text after gates', async () => {
  const wav = path.join(TMP, 'silence.wav');
  fs.writeFileSync(wav, encodeWav(new Float32Array(32000), 16000));
  const r = await server.transcribe(wav, 2000);
  const cleaned = pp.process(r.text, { rms: 0.0001, silenceRms: 0.0045 });
  assert(r.noSpeech || cleaned === '', `silence produced text: "${r.text}" → "${cleaned}"`);
});

test('server: 30s clip transcribes within scaled timeout', async () => {
  const long = SENTENCES.concat(SENTENCES, SENTENCES).join(' ');
  const wav = path.join(TMP, 'long.wav');
  synthWav(long, wav, 1);
  const t0 = Date.now();
  const r = await server.transcribe(wav, 35000);
  const score = wordOverlap(long, r.text);
  console.log(`       [${r.engine}] ${Date.now() - t0}ms for long clip, overlap ${(score * 100).toFixed(0)}%`);
  assert(score >= 0.7, `long-clip overlap ${score}`);
});

// The app's hot path hands the transcriber an in-memory Buffer, not a file —
// both engines must accept it (server posts it; cli materializes a temp wav).
test('server: Buffer input matches file input', async () => {
  const buf = fs.readFileSync(path.join(TMP, 's0.wav'));
  const r = await server.transcribe(buf, 6000);
  const score = wordOverlap(SENTENCES[0], r.text);
  console.log(`       [${r.engine} ${r.ms}ms buffer] "${r.text.trim()}"`);
  assert(r.engine === 'server', 'engine should be server');
  assert(score >= 0.7, `buffer overlap ${score}`);
});

test('cli engine: sentence 1 ≥70% overlap (file and Buffer)', async () => {
  const cli = new Transcriber(paths);
  cli.cliLocked = true;
  cli.configure({ modelPath: MODEL, language: 'en', prompt: '' });
  await cli.ensure();
  const r = await cli.transcribe(path.join(TMP, 's0.wav'), 6000);
  const score = wordOverlap(SENTENCES[0], r.text);
  console.log(`       [${r.engine} ${r.ms}ms] "${r.text.trim()}"`);
  assert(r.engine === 'cli', 'engine should be cli');
  assert(score >= 0.7, `overlap ${score}`);
  const rb = await cli.transcribe(fs.readFileSync(path.join(TMP, 's0.wav')), 6000);
  assert(wordOverlap(SENTENCES[0], rb.text) >= 0.7, `cli buffer overlap`);
  await cli.shutdown();
});

test('dictionary prompt biases recognition (boost words accepted)', async () => {
  const boosted = new Transcriber(paths);
  boosted.configure({ modelPath: MODEL, language: 'en', prompt: 'VoiceLatch, Naveed, gstack' });
  const engine = await boosted.ensure();
  assert(engine === 'server' || engine === 'cli', 'engine up with prompt');
  const r = await boosted.transcribe(path.join(TMP, 's2.wav'), 6000);
  assert(r.text.trim().length > 10, 'prompted engine still transcribes');
  await boosted.shutdown();
});

process.on('exit', () => { try { server && server.shutdown(); } catch (_) {} });

run('accuracy');

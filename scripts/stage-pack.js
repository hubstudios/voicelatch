'use strict';

/* Stages the installer payload into runtime/pack/ (referenced by
 * package.json build.extraResources). Ships only what dictation needs:
 * the two whisper exes, their DLLs (every CPU-variant kernel, so one
 * installer runs on any x64 machine), app-local MSVC runtime, the injector,
 * and the bundled English model. ~160 MB instead of the full 700 MB zip. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_BIN = path.join(ROOT, 'runtime', 'bin', 'Release');
const SRC_MODELS = path.join(ROOT, 'runtime', 'models');
const PACK = path.join(ROOT, 'runtime', 'pack');
const PACK_BIN = path.join(PACK, 'bin');
const PACK_MODELS = path.join(PACK, 'models');

const KEEP_EXACT = [
  'whisper-cli.exe', 'whisper-server.exe', 'injector.exe',
  'whisper.dll', 'ggml.dll', 'ggml-base.dll',
  'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
];
const KEEP_PATTERN = /^ggml-cpu-.*\.dll$/;
const BUNDLED_MODELS = ['ggml-base.en-q5_1.bin']; // compressed: 57 MB vs 148, faster, same accuracy

fs.rmSync(PACK, { recursive: true, force: true });
fs.mkdirSync(PACK_BIN, { recursive: true });
fs.mkdirSync(PACK_MODELS, { recursive: true });

let bytes = 0;
let missing = [];
for (const f of fs.readdirSync(SRC_BIN)) {
  if (KEEP_EXACT.includes(f) || KEEP_PATTERN.test(f)) {
    fs.copyFileSync(path.join(SRC_BIN, f), path.join(PACK_BIN, f));
    bytes += fs.statSync(path.join(PACK_BIN, f)).size;
  }
}
for (const f of KEEP_EXACT) {
  if (!fs.existsSync(path.join(PACK_BIN, f))) missing.push(f);
}
for (const m of BUNDLED_MODELS) {
  const src = path.join(SRC_MODELS, m);
  if (!fs.existsSync(src)) { missing.push(m); continue; }
  fs.copyFileSync(src, path.join(PACK_MODELS, m));
  bytes += fs.statSync(src).size;
}

if (missing.length) {
  console.error(`stage-pack: MISSING ${missing.join(', ')} — run npm run setup first`);
  process.exit(1);
}
console.log(`stage-pack: ${(bytes / 1e6).toFixed(0)} MB staged to runtime/pack`);

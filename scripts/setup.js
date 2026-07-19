'use strict';

/* One-command environment bootstrap (Windows, no npm deps):
 *   node scripts/setup.js [--download-only]
 * 1. whisper.cpp v1.9.1 win-x64 binaries  → runtime/bin/Release   (pinned URL)
 * 2. MSVC runtime DLLs app-local          → beside the whisper exes
 * 3. ggml-base.en.bin + ggml-base.bin     → runtime/models        (pinned URLs)
 * 4. injector.cs → injector.exe via the C# compiler built into Windows
 * 5. app/tray icons via scripts/gen-icons.ps1
 * Idempotent: every step skips work that's already done.
 * Zip extraction uses tar.exe (bsdtar) — Node-based unzip deadlocks on this
 * machine (known Windows issue; same workaround as Playwright/Electron).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const BIN = path.join(RUNTIME, 'bin', 'Release');
const MODELS = path.join(RUNTIME, 'models');

const WHISPER_ZIP_URL =
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip';
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODEL_FILES = [
  { file: 'ggml-base.en-q5_1.bin', minBytes: 45e6 }, // default + bundled in installer
  { file: 'ggml-base.en.bin', minBytes: 120e6 },
  { file: 'ggml-base.bin', minBytes: 120e6 },
];
const VC_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

const downloadOnly = process.argv.includes('--download-only');
let failures = 0;

function step(name, ok, detail) {
  console.log(`${ok ? 'OK ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function download(url, dest, minBytes) {
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const out = fs.createWriteStream(part);
  let bytes = 0;
  for await (const chunk of res.body) {
    if (!out.write(Buffer.from(chunk))) {
      await new Promise((r) => out.once('drain', r)); // backpressure
    }
    bytes += chunk.length;
    if (bytes % (20 * 1024 * 1024) < chunk.length) process.stdout.write('.');
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  process.stdout.write('\n');
  const size = fs.statSync(part).size;
  if (minBytes && size < minBytes) throw new Error(`too small: ${size} bytes`);
  fs.renameSync(part, dest);
  return size;
}

function findVcRuntime() {
  // Modern MSVC runtime copies shipped by always-present Microsoft apps.
  const roots = [
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application'),
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'EdgeWebView', 'Application'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'OneDrive'),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      for (const sub of fs.readdirSync(root)) {
        const dir = path.join(root, sub);
        if (VC_DLLS.every((d) => fs.existsSync(path.join(dir, d)))) return dir;
      }
    } catch (_) { /* next root */ }
  }
  return null;
}

async function main() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(MODELS, { recursive: true });

  // 1. whisper binaries
  const cli = path.join(BIN, 'whisper-cli.exe');
  if (fs.existsSync(cli)) {
    step('whisper binaries', true, 'already present');
  } else {
    try {
      const zip = path.join(RUNTIME, 'whisper-bin-x64.zip');
      if (!fs.existsSync(zip)) {
        console.log('downloading whisper.cpp v1.9.1 binaries…');
        await download(WHISPER_ZIP_URL, zip, 5e6);
      }
      const r = spawnSync('tar', ['-xf', zip, '-C', path.join(RUNTIME, 'bin')], { stdio: 'inherit' });
      step('whisper binaries', r.status === 0 && fs.existsSync(cli));
    } catch (e) {
      step('whisper binaries', false, e.message);
    }
  }

  // 2. app-local MSVC runtime (whisper-server AVs on 2019-era system DLLs)
  const missing = VC_DLLS.filter((d) => !fs.existsSync(path.join(BIN, d)));
  if (missing.length === 0) {
    step('MSVC runtime DLLs', true, 'already present');
  } else {
    const src = findVcRuntime();
    if (src) {
      for (const d of VC_DLLS) fs.copyFileSync(path.join(src, d), path.join(BIN, d));
      step('MSVC runtime DLLs', true, `copied from ${src}`);
    } else {
      step('MSVC runtime DLLs', false,
        'no modern copy found — install the VC++ x64 redistributable, then re-run');
    }
  }

  // 3. models
  for (const m of MODEL_FILES) {
    const dest = path.join(MODELS, m.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= m.minBytes) {
      step(`model ${m.file}`, true, 'already present');
      continue;
    }
    try {
      console.log(`downloading ${m.file} (~140 MB)…`);
      const size = await download(HF + m.file, dest, m.minBytes);
      step(`model ${m.file}`, true, `${(size / 1e6).toFixed(0)} MB`);
    } catch (e) {
      step(`model ${m.file}`, false, e.message);
    }
  }

  if (downloadOnly) return report();

  // 4. injector
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const r = spawnSync(csc, [
    '/nologo', '/optimize', '/target:exe',
    `/out:${path.join(BIN, 'injector.exe')}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    path.join(ROOT, 'native', 'injector.cs'),
  ], { encoding: 'utf8' });
  step('injector.exe compile', r.status === 0, r.status === 0 ? '' : (r.stdout || r.stderr || '').slice(0, 300));

  // 5. icons
  if (fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
    step('icons', true, 'already present');
  } else {
    const ri = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'gen-icons.ps1'),
    ], { encoding: 'utf8' });
    step('icons', ri.status === 0, (ri.stdout || '').trim().slice(0, 120));
  }

  report();
}

function report() {
  console.log(failures === 0
    ? '\nSetup complete — run: npm start   (or npm run selftest)'
    : `\nSetup finished with ${failures} failure(s) — see above.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('setup crashed:', e); process.exit(1); });

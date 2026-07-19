'use strict';

/* Full verification suite orchestrator: npm run selftest
 * Order: cheap/pure first, focus-stealing + audible last.
 * Writes selftest-artifacts/summary.json. Exit 0 only if every suite passes. */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'selftest-artifacts');
fs.mkdirSync(ART, { recursive: true });

const results = [];

function record(name, code, ms, note) {
  results.push({ name, ok: code === 0, code, ms, note: note || '' });
  console.log(`\n>>> ${name}: ${code === 0 ? 'PASS' : `FAIL (exit ${code})`} in ${(ms / 1000).toFixed(1)}s\n`);
}

function runNode(name, script, extraEnv) {
  const t0 = Date.now();
  const r = spawnSync('node', [script], {
    cwd: ROOT, stdio: 'inherit', timeout: 15 * 60000,
    env: { ...process.env, ...(extraEnv || {}) },
  });
  record(name, r.status === null ? -1 : r.status, Date.now() - t0);
}

function runElectron(name, args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args, { cwd: ROOT, stdio: 'ignore' });
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 5 * 60000);
    p.on('exit', (code) => {
      clearTimeout(killer);
      record(name, code === null ? -1 : code, Date.now() - t0);
      resolve();
    });
  });
}

async function main() {
  console.log('VoiceLatch verification suite');
  console.log('NOTE: later stages open small test windows, steal focus briefly,');
  console.log('      and play a spoken sentence through the speakers.\n');

  // Preflight: a running production instance shares %APPDATA% and its
  // single-instance lock — it would silently no-op the in-app smoke and
  // steal focus from injection tests. Stop it first.
  try {
    const q = spawnSync('tasklist', ['/FI', 'IMAGENAME eq VoiceLatch.exe', '/FO', 'CSV'], { encoding: 'utf8' });
    if ((q.stdout || '').includes('VoiceLatch.exe')) {
      console.log('NOTE: stopping the running VoiceLatch app for the duration of the suite.');
      spawnSync('taskkill', ['/IM', 'VoiceLatch.exe', '/F'], { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch (_) { /* best effort */ }

  // Preflight: environment must be set up.
  const need = [
    ['runtime\\bin\\Release\\whisper-cli.exe', 'npm run setup'],
    ['runtime\\bin\\Release\\injector.exe', 'npm run setup'],
    ['runtime\\models\\ggml-base.en.bin', 'npm run setup'],
    ['node_modules\\electron\\dist\\electron.exe', 'npm install'],
  ];
  for (const [rel, fix] of need) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      console.error(`MISSING: ${rel}\n  cause: environment not bootstrapped\n  fix:   ${fix}`);
      process.exit(2);
    }
  }

  runNode('unit', 'scripts/tests/unit.test.js');
  runNode('injector round-trips', 'scripts/tests/injector.test.js');
  runNode('transcription accuracy', 'scripts/tests/accuracy.test.js');
  runNode('engine failover', 'scripts/tests/engine-failover.test.js');
  runNode('pipeline (speech→keys)', 'scripts/tests/pipeline.test.js');

  // In-app smoke against the real app (real hook, tray, mic, engine).
  const refWav = path.join(ART, 'ref.wav');
  const { synthWav } = require('./tests/tts');
  synthWav('Voice dictation should feel effortless and fast.', refWav, 0);
  const smokeStart = Date.now();
  await runElectron('app selftest (real app)', [
    '.', '--selftest', '--selftest-wav', refWav, '--selftest-out', ART,
  ]);
  // Exit code alone is not proof — require a FRESH report.json that says ok.
  const smoke = results[results.length - 1];
  if (smoke.ok) {
    try {
      const repPath = path.join(ART, 'report.json');
      const fresh = fs.statSync(repPath).mtimeMs >= smokeStart;
      const rep = JSON.parse(fs.readFileSync(repPath, 'utf8'));
      if (!fresh || !rep.ok) {
        smoke.ok = false;
        smoke.note = fresh ? 'report.json says not ok' : 'stale report.json — app never ran the selftest';
        console.log(`>>> app selftest invalidated: ${smoke.note}`);
      }
    } catch (e) {
      smoke.ok = false;
      smoke.note = `no readable report.json: ${e.message}`;
    }
  }

  runNode('chained E2E (hotkey→mic→inject)', 'scripts/tests/chained-e2e.test.js');

  const ok = results.every((r) => r.ok);
  const summary = { ok, when: new Date().toISOString(), results };
  fs.writeFileSync(path.join(ART, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n================ SUMMARY ================');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${(r.ms / 1000).toFixed(1)}s)`);
  }
  console.log(ok ? '\nALL GREEN ✔' : '\nFAILURES — see above.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

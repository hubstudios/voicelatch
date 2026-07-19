'use strict';

// Zero-dependency test harness: test('name', fn) + await run().
const tests = [];
let failures = 0;

function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

async function run(suiteName) {
  const t0 = Date.now();
  for (const t of tests) {
    const s = Date.now();
    try {
      await t.fn();
      console.log(`  PASS ${t.name} (${Date.now() - s}ms)`);
    } catch (e) {
      failures++;
      console.log(`  FAIL ${t.name}\n       ${String(e.message).replace(/\n/g, '\n       ')}`);
    }
  }
  console.log(`${suiteName}: ${tests.length - failures}/${tests.length} passed (${Date.now() - t0}ms)`);
  process.exit(failures ? 1 : 0);
}

// Word-level overlap for transcription accuracy scoring.
function wordOverlap(reference, hypothesis) {
  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  const ref = norm(reference);
  const hyp = norm(hypothesis);
  const bag = new Map();
  for (const w of hyp) bag.set(w, (bag.get(w) || 0) + 1);
  let hits = 0;
  for (const w of ref) {
    const n = bag.get(w) || 0;
    if (n > 0) { hits++; bag.set(w, n - 1); }
  }
  return ref.length ? hits / ref.length : 0;
}

// Focus-sensitive tests (SendInput into a focused window) lose races against
// a human actively typing — Windows restricts foreground changes during live
// input. Wait for the desktop to go quiet before those stages.
async function waitForUserIdle(injectorExe, needIdleMs, maxWaitMs) {
  const { spawnSync } = require('child_process');
  needIdleMs = needIdleMs || 4000;
  maxWaitMs = maxWaitMs || 90000;
  const t0 = Date.now();
  let announced = false;
  while (Date.now() - t0 < maxWaitMs) {
    const r = spawnSync(injectorExe, ['idlems'], { encoding: 'utf8', timeout: 10000 });
    const idle = r.status === 0 ? parseInt(r.stdout, 10) : NaN;
    if (!Number.isFinite(idle)) return true; // can't measure → don't block
    if (idle >= needIdleMs) return true;
    if (!announced) {
      console.log('  (waiting for keyboard/mouse to go idle — hands off for a few seconds…)');
      announced = true;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  console.log('  (desktop never went idle — proceeding anyway, focus races possible)');
  return false;
}

module.exports = { test, run, assert, assertEq, wordOverlap, waitForUserIdle };

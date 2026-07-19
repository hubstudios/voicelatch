'use strict';

const fs = require('fs');
const path = require('path');

let logFile = null;
let stream = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'voicelatch.log');
    // Rotate at ~2 MB so the log never balloons.
    try {
      const st = fs.statSync(logFile);
      if (st.size > 2 * 1024 * 1024) {
        fs.renameSync(logFile, path.join(dir, 'voicelatch.prev.log'));
      }
    } catch (_) { /* first run */ }
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (e) {
    // Logging must never break the app.
    stream = null;
  }
}

function line(level, args) {
  const msg = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
      return String(a);
    })
    .join(' ');
  const out = `${new Date().toISOString()} [${level}] ${msg}`;
  if (stream) { try { stream.write(out + '\n'); } catch (_) {} }
  if (process.env.VOICELATCH_DEBUG || level === 'ERR') {
    // eslint-disable-next-line no-console
    console.log(out);
  }
}

module.exports = {
  init,
  info: (...a) => line('INF', a),
  warn: (...a) => line('WRN', a),
  error: (...a) => line('ERR', a),
  get file() { return logFile; },
};

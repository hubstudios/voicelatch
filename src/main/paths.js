'use strict';

const fs = require('fs');
const path = require('path');

// Runtime artifact resolution. Search order (first hit wins):
//   1. %APPDATA%\VoiceLatch\…       (in-app downloads / manual upgrades)
//   2. <resources>\…             (packaged installer payload)
//   3. <repo>\runtime\…          (dev checkout)
// Set VOICELATCH_IGNORE_DEV_RUNTIME=1 to simulate a clean PC (used by tests).

function resolveAll(app) {
  const userDataDir = app.getPath('userData');
  const appRoot = path.join(__dirname, '..', '..');
  const devOk = !process.env.VOICELATCH_IGNORE_DEV_RUNTIME;

  const binRoots = [
    path.join(userDataDir, 'bin'),
    path.join(process.resourcesPath || '', 'bin'),
    devOk ? path.join(appRoot, 'runtime', 'bin', 'Release') : null,
  ].filter(Boolean);

  const modelRoots = [
    path.join(userDataDir, 'models'),
    path.join(process.resourcesPath || '', 'models'),
    devOk ? path.join(appRoot, 'runtime', 'models') : null,
  ].filter(Boolean);

  const firstWith = (roots, file) => {
    for (const r of roots) {
      try {
        const p = path.join(r, file);
        if (fs.existsSync(p)) return p;
      } catch (_) { /* keep looking */ }
    }
    return null;
  };

  const whisperCli = firstWith(binRoots, 'whisper-cli.exe');
  const whisperServer = firstWith(binRoots, 'whisper-server.exe');
  const injectorExe = firstWith(binRoots, 'injector.exe');

  const publicDir = path.join(userDataDir, 'public');
  const tmpDir = path.join(userDataDir, 'tmp');
  const logsDir = path.join(userDataDir, 'logs');
  const downloadModelsDir = path.join(userDataDir, 'models');
  for (const d of [publicDir, tmpDir, logsDir, downloadModelsDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }

  return {
    userDataDir,
    appRoot,
    binRoots,
    modelRoots,
    binDir: whisperCli ? path.dirname(whisperCli) : null,
    whisperCli,
    whisperServer,
    injectorExe,
    publicDir,
    tmpDir,
    logsDir,
    downloadModelsDir,
    findModel(file) { return firstWith(modelRoots, file); },
  };
}

module.exports = { resolveAll };

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const log = require('./log');

// Benchmarked on the i7-1255U (hybrid P+E cores): all physical cores beat the
// old cap of 8, and whisper.cpp gains little beyond 10 threads anywhere.
const THREADS = Math.max(2, Math.min(10, os.cpus().length - 2));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitPort(port, timeoutMs, proc) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (proc && proc.exitCode !== null) {
        return reject(new Error(`server exited early (code ${proc.exitCode})`));
      }
      const sock = net.connect({ port, host: '127.0.0.1' }, () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('server start timeout'));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

// Both engines behind one interface. Server = model warm in RAM (fast path);
// CLI = spawn per utterance (slow but bulletproof). Two consecutive server
// failures lock the session to CLI. All calls are single-flight.
class Transcriber {
  constructor(paths) {
    this.paths = paths;
    this.proc = null;
    this.port = null;
    this.config = null;       // active server config signature
    this.pending = null;      // desired config
    this.engine = 'none';     // 'server' | 'cli' | 'none'
    this.cliLocked = false;
    this.serverFails = 0;
    this._chain = Promise.resolve();
    this._killedByUs = false;
    this.idleUnloadMs = 0;    // 0 = keep the model warm forever
    this._idleTimer = null;
    this._lastUse = Date.now();
    this.onEngineChange = null; // optional hook, set by main
    this.noFa = false;        // set when flash-attention crashed the server once
  }

  configure({ modelPath, language, prompt, idleUnloadMs }) {
    this.pending = {
      modelPath,
      language: language || 'en',
      prompt: (prompt || '').slice(0, 800),
    };
    if (typeof idleUnloadMs === 'number') this.idleUnloadMs = idleUnloadMs;
    this._armIdleTimer();
  }

  _emitEngine(engine) {
    if (this.onEngineChange) { try { this.onEngineChange(engine); } catch (_) {} }
  }

  // After idleUnloadMs without use, release the warm server (~300 MB RAM).
  // The unload rides the single-flight queue, so it can never land mid-request,
  // and engine→'none' makes the next transcribe re-warm cleanly WITHOUT
  // counting as a server failure (which would wrongly cli-lock the session).
  _armIdleTimer() {
    clearTimeout(this._idleTimer);
    if (!this.idleUnloadMs || this.idleUnloadMs <= 0) return;
    this._idleTimer = setTimeout(() => {
      this._enqueue(async () => {
        if (!this.idleUnloadMs) return;
        if (Date.now() - this._lastUse < this.idleUnloadMs) { this._armIdleTimer(); return; }
        if (this.engine === 'server' && this.proc) {
          log.info('idle: unloading warm model to free memory');
          await this._killServer();
          this.engine = 'none';
          this._emitEngine('idle');
        }
      });
    }, this.idleUnloadMs + 500);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _sig(c) { return c ? `${c.modelPath}|${c.language}|${c.prompt}` : ''; }

  get ready() { return this.engine !== 'none'; }

  async ensure() {
    // serialize with transcriptions so a respawn never kills an in-flight request
    return this._enqueue(() => this._ensureInner());
  }

  async _ensureInner() {
    const want = this.pending;
    if (!want || !want.modelPath) throw new Error('No model configured');
    if (!fs.existsSync(want.modelPath)) throw new Error(`Model missing: ${want.modelPath}`);
    if (this.cliLocked) {
      await this._killServer(); // never leave a wedged server holding the model in RAM
      this.engine = 'cli';
      this.config = { ...want };
      return this.engine;
    }
    const alive = this.proc && this.proc.exitCode === null;
    if (alive && this._sig(this.config) === this._sig(want)) return this.engine;

    await this._killServer();
    if (!this.paths.whisperServer) {
      this.engine = 'cli';
      this.config = { ...want };
      return this.engine;
    }
    try {
      await this._spawnServer(want);
      this.engine = 'server';
      this.serverFails = 0;
    } catch (e) {
      log.warn('server start failed, falling back to cli:', e.message);
      this._noteServerFailure();
      this.engine = 'cli';
    }
    this.config = { ...want };
    this._emitEngine(this.engine);
    return this.engine;
  }

  async _spawnServer(cfg, attempt) {
    attempt = attempt || 0;
    this.port = await freePort();
    const lang = cfg.modelPath.includes('.en.') ? 'en' : cfg.language;
    const args = [
      '-m', cfg.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-t', String(THREADS),
      '-bs', '1',            // greedy decode: ~2× faster per utterance, dictation-grade accuracy
      '--public', this.paths.publicDir,
      '-l', lang,
    ];
    // Flash attention: benchmarked ~25% faster per utterance on this class of
    // CPU and stable — but if the server ever dies starting with it, we retry
    // once without and pin that for the session (see catch below).
    if (this.noFa) args.push('-nfa');
    if (cfg.prompt) args.push('--prompt', cfg.prompt);
    log.info('spawning whisper-server', this.port, path.basename(cfg.modelPath), lang,
      this.noFa ? '(no flash-attn)' : '(flash-attn)');
    this._killedByUs = false;
    const proc = spawn(this.paths.whisperServer, args, {
      cwd: this.paths.binDir,          // required — validated crash lesson
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderrTail = '';
    proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    proc.on('exit', (code) => {
      if (!this._killedByUs) log.warn('whisper-server exited', code, stderrTail.slice(-400));
      if (this.proc === proc) this.proc = null;
    });
    this.proc = proc;
    try {
      await waitPort(this.port, 25000, proc);
    } catch (e) {
      proc.kill();
      if (attempt === 0 && /exited early/.test(e.message)) {
        // Either a port race or flash-attention killed it on this hardware —
        // one retry covers both: fresh port, and conservative attn from now on.
        if (!this.noFa) {
          this.noFa = true;
          log.warn('server died at start — retrying without flash-attention');
        }
        return this._spawnServer(cfg, 1);
      }
      throw e;
    }
  }

  _noteServerFailure() {
    this.serverFails++;
    if (this.serverFails >= 2 && !this.cliLocked) {
      this.cliLocked = true;
      this.engine = 'cli'; // route immediately — never wait on the wedged server again
      this._killServer().catch(() => {});
      log.warn('server failed twice — session locked to cli engine');
    }
  }

  async _killServer() {
    if (this.proc && this.proc.exitCode === null) {
      this._killedByUs = true;
      this.proc.kill();
      const p = this.proc;
      await new Promise((res) => {
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} res(); }, 1500);
        p.on('exit', () => { clearTimeout(t); res(); });
      });
    }
    this.proc = null;
  }

  _enqueue(fn) {
    const run = this._chain.then(fn, fn);
    // keep the chain alive after failures
    this._chain = run.catch(() => {});
    return run;
  }

  // `wav` is a Buffer (hot path — no disk round-trip) or a file path (tests,
  // CLI). The server path streams the buffer straight into the request.
  transcribe(wav, durationMs) {
    return this._enqueue(() => this._transcribeInner(wav, durationMs));
  }

  async _transcribeInner(wav, durationMs) {
    this._lastUse = Date.now();
    this._armIdleTimer();
    if (this._sig(this.config) !== this._sig(this.pending) || this.engine === 'none') {
      await this._ensureInner();
    }
    const started = Date.now();
    const timeoutMs = 30000 + 3 * (durationMs || 10000);
    let lastErr = null;

    if (this.engine === 'server' && !this.cliLocked) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await this._viaServer(wav, timeoutMs);
          return { ...out, engine: 'server', ms: Date.now() - started };
        } catch (e) {
          lastErr = e;
          log.warn(`server transcribe attempt ${attempt + 1} failed:`, e.message);
          const dead = !this.proc || this.proc.exitCode !== null;
          if (attempt === 0 && dead && !this.cliLocked) {
            if (!this.noFa) {
              this.noFa = true; // died mid-request: retry conservative before giving up on server
              log.warn('server died during inference — respawning without flash-attention');
            }
            try { await this._spawnServer(this.config); continue; } catch (e2) { lastErr = e2; }
          }
          break;
        }
      }
      this._noteServerFailure();
      log.warn('falling back to cli for this utterance');
    }

    try {
      const out = await this._viaCli(wav, timeoutMs);
      return { ...out, engine: 'cli', ms: Date.now() - started };
    } catch (e) {
      throw lastErr && this.engine === 'server' ? lastErr : e;
    }
  }

  async _viaServer(wav, timeoutMs) {
    const buf = Buffer.isBuffer(wav) ? wav : fs.readFileSync(wav);
    const form = new FormData();
    form.append('file', new Blob([buf]), 'audio.wav');
    form.append('response_format', 'verbose_json');
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`server HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`server: ${json.error}`);
    const segments = Array.isArray(json.segments) ? json.segments : [];
    // Hallucination gate: whisper marks phantom output on non-speech with a
    // high per-segment no_speech probability.
    const speechy = segments.filter((s) => (s.no_speech_prob ?? 0) < 0.66);
    if (segments.length > 0 && speechy.length === 0) {
      return { text: '', noSpeech: true };
    }
    const text = (json.text != null ? json.text : segments.map((s) => s.text).join(' ')) || '';
    return { text: text.trim(), noSpeech: false };
  }

  _viaCli(wav, timeoutMs) {
    const cfg = this.config;
    const lang = cfg.modelPath.includes('.en.') ? 'en' : cfg.language;
    // The CLI needs a real file — materialize buffers to a temp wav.
    let wavPath = wav;
    let tempWav = null;
    if (Buffer.isBuffer(wav)) {
      tempWav = path.join(os.tmpdir(), `voicelatch-cli-${Date.now()}-${process.pid}.wav`);
      fs.writeFileSync(tempWav, wav);
      wavPath = tempWav;
    }
    const args = [
      '-m', cfg.modelPath,
      '-f', wavPath,
      '-l', lang,
      '-t', String(THREADS),
      '-bs', '1',            // greedy, matching the server path
      '-np', '-nt',
    ];
    if (cfg.prompt) args.push('--prompt', cfg.prompt);
    const cleanup = () => { if (tempWav) { try { fs.unlinkSync(tempWav); } catch (_) {} } };
    return new Promise((resolve, reject) => {
      const proc = spawn(this.paths.whisperCli, args, {
        cwd: this.paths.binDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const killer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        cleanup();
        reject(new Error('cli timeout'));
      }, timeoutMs + 30000);
      proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
      proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-1500); });
      proc.on('error', (e) => { clearTimeout(killer); cleanup(); reject(e); });
      proc.on('exit', (code) => {
        clearTimeout(killer);
        cleanup();
        if (code !== 0) return reject(new Error(`cli exit ${code}: ${err.slice(-300)}`));
        resolve({ text: out.replace(/\r/g, '').trim(), noSpeech: false });
      });
    });
  }

  async shutdown() {
    clearTimeout(this._idleTimer);
    this.pending = null;
    await this._killServer();
    this.engine = 'none';
  }
}

module.exports = { Transcriber, THREADS };

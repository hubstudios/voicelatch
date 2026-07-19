'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

const REGISTRY = [
  { id: 'tiny.en-q5_1', file: 'ggml-tiny.en-q5_1.bin', mb: 31, lang: 'en', label: 'Tiny · English (compressed)', desc: 'Speed pick — ~2× faster than Base for quick notes; noticeably less accurate' },
  { id: 'tiny.en', file: 'ggml-tiny.en.bin', mb: 75, lang: 'en', label: 'Tiny · English', desc: 'Fastest, lowest accuracy' },
  { id: 'tiny', file: 'ggml-tiny.bin', mb: 75, lang: 'multi', label: 'Tiny · Multilingual', desc: 'Fastest, lowest accuracy' },
  { id: 'base.en-q5_1', file: 'ggml-base.en-q5_1.bin', mb: 57, lang: 'en', label: 'Base · English (compressed)', desc: 'Recommended — fastest response, same accuracy in testing', recommended: true },
  { id: 'base.en', file: 'ggml-base.en.bin', mb: 142, lang: 'en', label: 'Base · English', desc: 'Uncompressed original of the recommended model' },
  { id: 'base-q5_1', file: 'ggml-base-q5_1.bin', mb: 57, lang: 'multi', label: 'Base · Multilingual (compressed)', desc: 'Fast, 99 languages' },
  { id: 'base', file: 'ggml-base.bin', mb: 142, lang: 'multi', label: 'Base · Multilingual', desc: 'Fast, 99 languages' },
  { id: 'small.en-q5_1', file: 'ggml-small.en-q5_1.bin', mb: 181, lang: 'en', label: 'Small · English (compressed)', desc: 'More accurate, still responsive' },
  { id: 'small.en', file: 'ggml-small.en.bin', mb: 466, lang: 'en', label: 'Small · English', desc: 'More accurate, ~2-3× slower' },
  { id: 'small-q5_1', file: 'ggml-small-q5_1.bin', mb: 181, lang: 'multi', label: 'Small · Multilingual (compressed)', desc: 'More accurate, still responsive' },
  { id: 'small', file: 'ggml-small.bin', mb: 466, lang: 'multi', label: 'Small · Multilingual', desc: 'More accurate, ~2-3× slower' },
  { id: 'large-v3-turbo-q5_0', file: 'ggml-large-v3-turbo-q5_0.bin', mb: 547, lang: 'multi', label: 'Large v3 Turbo (q5)', desc: 'Best accuracy, slowest on CPU' },
];

const LANGUAGES = [
  ['auto', 'Auto-detect'], ['en', 'English'], ['ar', 'Arabic'], ['ur', 'Urdu'],
  ['hi', 'Hindi'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['tr', 'Turkish'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['nl', 'Dutch'],
  ['fa', 'Persian'], ['tl', 'Filipino'], ['ml', 'Malayalam'], ['ta', 'Tamil'],
];

class ModelManager {
  constructor(paths) {
    this.paths = paths;
    this.active = new Map(); // id → AbortController
  }

  list(activeModelId) {
    return REGISTRY.map((m) => {
      const found = this.paths.findModel(m.file);
      return {
        ...m,
        installed: !!found,
        path: found,
        downloading: this.active.has(m.id),
        active: m.id === activeModelId,
      };
    });
  }

  get(id) { return REGISTRY.find((m) => m.id === id) || null; }

  // Streams to <file>.part, verifies size, renames atomically. A killed
  // download can never leave a half model where the engine will find it.
  async download(id, onProgress) {
    const m = this.get(id);
    if (!m) throw new Error(`Unknown model: ${id}`);
    if (this.active.has(id)) throw new Error('Already downloading');
    const dest = path.join(this.paths.downloadModelsDir, m.file);
    const part = `${dest}.part`;
    const ctl = new AbortController();
    this.active.set(id, ctl);
    try {
      const res = await fetch(HF_BASE + m.file, { signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} from model host`);
      const total = Number(res.headers.get('content-length')) || m.mb * 1e6;
      const out = fs.createWriteStream(part);
      this._activeStream = out;
      let received = 0;
      let lastEmit = 0;
      for await (const chunk of res.body) {
        // Honor backpressure — a fast connection must not buffer a 550 MB
        // model in memory ahead of a slow disk.
        if (!out.write(Buffer.from(chunk))) {
          await new Promise((r) => out.once('drain', r));
        }
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 150) {
          lastEmit = now;
          onProgress && onProgress({ id, received, total, pct: Math.min(99, Math.round((received / total) * 100)) });
        }
      }
      await new Promise((res2, rej) => out.end((e) => (e ? rej(e) : res2())));
      const size = fs.statSync(part).size;
      const expectedMin = m.mb * 1e6 * 0.85;
      if (size < expectedMin || (Number(res.headers.get('content-length')) && size !== Number(res.headers.get('content-length')))) {
        throw new Error(`Download incomplete (${size} bytes)`);
      }
      fs.renameSync(part, dest);
      onProgress && onProgress({ id, received: size, total: size, pct: 100, done: true });
      log.info('model downloaded', id, size);
      return dest;
    } catch (e) {
      // Close the handle BEFORE unlinking — Windows defers deletion of open
      // files, which would leave a locked .part blocking the retry.
      try { this._activeStream && this._activeStream.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 80));
      try { fs.unlinkSync(part); } catch (_) {}
      if (e.name === 'AbortError') {
        log.info('model download cancelled', id);
        throw new Error('cancelled');
      }
      log.error('model download failed', id, e.message);
      throw e;
    } finally {
      this.active.delete(id);
    }
  }

  cancel(id) {
    const ctl = this.active.get(id);
    if (ctl) ctl.abort();
  }

  // Corruption floor is per-model: quantized models are legitimately small
  // (base.en-q5_1 ≈ 57 MB), so a global byte floor would reject them.
  validateModelFile(p, m) {
    try { return validateModelSize(fs.statSync(p).size, m); } catch (_) { return false; }
  }

  // Resolve which model to actually run: the configured one if its file
  // exists, else the recommended default, else anything installed. Keeps the
  // app dictating after upgrades that change the bundled model, or if the
  // user deletes model files by hand.
  resolveActive(settingsModelId) {
    const tryEntry = (m) => {
      if (!m) return null;
      const p = this.paths.findModel(m.file);
      return p && this.validateModelFile(p, m) ? { id: m.id, path: p, entry: m } : null;
    };
    const configured = tryEntry(this.get(settingsModelId));
    if (configured) return { ...configured, changed: false };
    const fallback =
      tryEntry(REGISTRY.find((m) => m.recommended)) ||
      REGISTRY.map(tryEntry).find(Boolean) ||
      null;
    return fallback ? { ...fallback, changed: true } : null;
  }
}

function validateModelSize(bytes, m) {
  const floor = m && m.mb ? m.mb * 0.8e6 : 25e6;
  return bytes > floor;
}

module.exports = { ModelManager, REGISTRY, LANGUAGES, validateModelSize };

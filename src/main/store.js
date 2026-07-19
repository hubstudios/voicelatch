'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./log');

const SETTINGS_DEFAULTS = {
  hotkey: { keycode: 3613, name: 'Right Ctrl' }, // uiohook CtrlRight; verified at runtime
  hotkeyMode: 'hold',        // 'hold' | 'toggle'
  model: 'base.en-q5_1',     // compressed: benchmarked faster, same accuracy
  language: 'en',            // 'en' | 'auto' | ISO code (multilingual models only)
  micDeviceId: 'default',
  injectionMode: 'paste',    // 'paste' | 'type'
  restoreClipboard: true,
  restoreDelayMs: 800,       // paste-consume margin; restore is async since
                             // v1.2.1, so a generous value costs no latency
  removeFillers: true,
  spokenCommands: true,      // "new line" / "new paragraph" / "bullet point"
  sounds: true,
  launchAtLogin: false,
  enabled: true,
  silenceRms: 0.0045,
  minRecordMs: 500,
  maxRecordMs: 600000,
  autoStopSilence: true,     // toggle mode: finish after a pause
  idleUnload: true,          // free the warm model after 10 idle minutes
  historyRetentionDays: 0,   // 0 = keep forever
  firstRunDone: false,
  // AI edits — OFF by default; when on, the finished TEXT of a dictation
  // (never audio) is sent to the configured provider for rewriting.
  aiEdits: false,
  aiProvider: 'groq',        // key of aiedit.PROVIDERS
  aiApiKey: '',              // plaintext in memory; encrypted at rest (DPAPI)
  aiModel: 'llama-3.3-70b-versatile',
  aiStyle: 'clean',          // key of aiedit.STYLES
  aiBaseUrl: '',             // override for 'custom' provider (llama.cpp etc.)
  aiTimeoutMs: 8000,         // then fail open: raw transcript is injected
};

const DICT_DEFAULTS = { boostWords: [], replacements: [] };

// The AI key never hits disk in plaintext when the OS can encrypt it
// (Electron safeStorage → Windows DPAPI, tied to this user account). Under
// plain-Node unit tests require('electron') yields no safeStorage, so keys
// pass through unencrypted there — tests never persist real keys.
let safeStorage = null;
try { safeStorage = require('electron').safeStorage || null; } catch (_) {}

function canEncrypt() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (_) { return false; }
}

const HISTORY_MAX_ENTRIES = 2000;
const HISTORY_MAX_TEXT = 5000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// Atomic write with retry — Windows AV scanners briefly lock destinations.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(data, null, 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      if (attempt === 2) {
        log.error('store write failed', file, e.message);
        try { fs.unlinkSync(tmp); } catch (_) {}
        return false;
      }
      const wait = 40 * (attempt + 1);
      const until = Date.now() + wait;
      while (Date.now() < until) { /* brief sync backoff */ }
    }
  }
  return false;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.settingsFile = path.join(dir, 'settings.json');
    this.historyFile = path.join(dir, 'history.json');
    this.dictFile = path.join(dir, 'dictionary.json');

    const loaded = readJson(this.settingsFile, {});
    this.settings = {
      ...SETTINGS_DEFAULTS,
      ...loaded,
      hotkey: { ...SETTINGS_DEFAULTS.hotkey, ...(loaded.hotkey || {}) },
    };
    if (this.settings.aiApiKeyEnc) {
      try {
        this.settings.aiApiKey = canEncrypt()
          ? safeStorage.decryptString(Buffer.from(this.settings.aiApiKeyEnc, 'base64'))
          : '';
      } catch (e) {
        log.warn('stored AI key could not be decrypted — clearing it', e.message);
        this.settings.aiApiKey = '';
      }
      delete this.settings.aiApiKeyEnc;
    }
    const loadedHistory = readJson(this.historyFile, []);
    this.history = pruneHistory(
      Array.isArray(loadedHistory) ? loadedHistory : [],
      this.settings.historyRetentionDays
    );
    const dict = readJson(this.dictFile, {});
    this.dictionary = {
      boostWords: Array.isArray(dict.boostWords) ? dict.boostWords : [],
      replacements: Array.isArray(dict.replacements) ? dict.replacements : [],
    };
    this._timers = {};
  }

  _debounced(name, fn, ms) {
    clearTimeout(this._timers[name]);
    this._timers[name] = setTimeout(fn, ms);
  }

  // What settings.json actually receives: aiApiKey swapped for its encrypted form.
  _settingsToDisk() {
    const s = { ...this.settings };
    if (s.aiApiKey && canEncrypt()) {
      s.aiApiKeyEnc = safeStorage.encryptString(s.aiApiKey).toString('base64');
      delete s.aiApiKey;
    }
    return s;
  }

  updateSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      hotkey: patch.hotkey ? { ...this.settings.hotkey, ...patch.hotkey } : this.settings.hotkey,
    };
    this._debounced('settings', () => writeJsonAtomic(this.settingsFile, this._settingsToDisk()), 200);
    return this.settings;
  }

  setDictionary(dict) {
    this.dictionary = {
      boostWords: (dict.boostWords || []).map((w) => String(w).trim()).filter(Boolean).slice(0, 200),
      replacements: (dict.replacements || [])
        .filter((r) => r && r.from && typeof r.to === 'string')
        .map((r) => ({ from: String(r.from).slice(0, 80), to: String(r.to).slice(0, 200) }))
        .slice(0, 200),
    };
    this._debounced('dict', () => writeJsonAtomic(this.dictFile, this.dictionary), 200);
    return this.dictionary;
  }

  addHistory(entry) {
    const e = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      text: String(entry.text || '').slice(0, HISTORY_MAX_TEXT),
      durationMs: entry.durationMs | 0,
      words: entry.words | 0,
      wpm: entry.wpm | 0,
      app: String(entry.app || '').slice(0, 80),
      engine: entry.engine || '',
      procMs: entry.procMs | 0,
      status: entry.status || 'injected',
      ai: !!entry.ai,
    };
    this.history.unshift(e);
    if (this.history.length > HISTORY_MAX_ENTRIES) this.history.length = HISTORY_MAX_ENTRIES;
    this.history = pruneHistory(this.history, this.settings.historyRetentionDays);
    this._debounced('history', () => writeJsonAtomic(this.historyFile, this.history), 400);
    return e;
  }

  deleteHistory(id) {
    this.history = this.history.filter((e) => e.id !== id);
    this._debounced('history', () => writeJsonAtomic(this.historyFile, this.history), 400);
  }

  clearHistory() {
    this.history = [];
    writeJsonAtomic(this.historyFile, this.history);
  }

  stats() {
    const ok = this.history.filter((e) => e.status === 'injected' || e.status === 'copied');
    const totalWords = ok.reduce((s, e) => s + (e.words || 0), 0);
    const totalMs = ok.reduce((s, e) => s + (e.durationMs || 0), 0);
    const avgWpm = totalMs > 0 ? Math.round(totalWords / (totalMs / 60000)) : 0;

    // Day streak: consecutive calendar days (local) with ≥1 entry, ending today/yesterday.
    const days = new Set(ok.map((e) => new Date(e.ts).toDateString()));
    let streak = 0;
    const d = new Date();
    if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1); // streak may end yesterday
    while (days.has(d.toDateString())) {
      streak++;
      d.setDate(d.getDate() - 1);
    }

    // Time saved vs typing at 40 WPM, minus time spent speaking.
    const typingMin = totalWords / 40;
    const savedMin = Math.max(0, Math.round(typingMin - totalMs / 60000));

    const dayMs = 24 * 3600 * 1000;
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const last7 = Array.from({ length: 7 }, (_, i) => {
      const start = today0.getTime() - (6 - i) * dayMs;
      const words = ok
        .filter((e) => e.ts >= start && e.ts < start + dayMs)
        .reduce((s, e) => s + (e.words || 0), 0);
      return { day: new Date(start).toLocaleDateString(undefined, { weekday: 'short' }), words };
    });

    return { totalWords, sessions: ok.length, avgWpm, streak, savedMin, last7 };
  }

  flush() {
    for (const t of Object.values(this._timers)) clearTimeout(t);
    writeJsonAtomic(this.settingsFile, this._settingsToDisk());
    writeJsonAtomic(this.historyFile, this.history);
    writeJsonAtomic(this.dictFile, this.dictionary);
  }
}

// retentionDays <= 0 means keep everything.
function pruneHistory(entries, retentionDays) {
  const days = Number(retentionDays) || 0;
  if (days <= 0) return entries;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return entries.filter((e) => (e.ts || 0) >= cutoff);
}

function historyToTxt(entries) {
  return entries
    .map((e) => {
      const when = new Date(e.ts).toLocaleString();
      const meta = [e.app, e.words ? `${e.words} words` : null, e.status]
        .filter(Boolean).join(' · ');
      return `[${when}] ${meta}\n${e.text}\n`;
    })
    .join('\n');
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function historyToCsv(entries) {
  const header = 'timestamp,app,words,wpm,status,engine,text';
  const rows = entries.map((e) => [
    new Date(e.ts).toISOString(), e.app, e.words, e.wpm, e.status, e.engine, e.text,
  ].map(csvCell).join(','));
  return [header, ...rows].join('\r\n');
}

module.exports = {
  Store, SETTINGS_DEFAULTS, DICT_DEFAULTS,
  pruneHistory, historyToTxt, historyToCsv, csvCell,
};

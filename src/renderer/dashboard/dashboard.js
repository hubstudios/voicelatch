'use strict';

/* Dashboard renderer: Home / History / Dictionary / Settings. All data flows
 * through the preload API (window.vox). */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let settings = null;
let appInfo = null;

// ------------------------------------------------------------------ helpers
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ router
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});
function showPage(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  if (name === 'home') renderHome();
  if (name === 'history') renderHistory();
  if (name === 'dictionary') renderDictionary();
  if (name === 'settings') renderSettings();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.vox.hideWindow();
});

// ------------------------------------------------------------------ home
async function renderHome() {
  const h = new Date().getHours();
  $('#greeting').textContent =
    h < 5 ? 'Late night session' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

  const stats = await window.vox.statsGet();
  $('#st-words').textContent = stats.totalWords.toLocaleString();
  $('#st-sessions').textContent = stats.sessions.toLocaleString();
  $('#st-wpm').textContent = stats.avgWpm;
  $('#st-streak').textContent = stats.streak;
  $('#st-saved').textContent = stats.savedMin >= 60
    ? `${Math.floor(stats.savedMin / 60)}h ${stats.savedMin % 60}m`
    : `${stats.savedMin}m`;
  drawChart(stats.last7);

  const recent = await window.vox.historyList('');
  const list = $('#recent-list');
  if (recent.length === 0) {
    list.innerHTML = `<div class="empty"><div class="big">🎙️</div>
      Nothing dictated yet.<br/>Hold <kbd>${esc(settings.hotkey.name)}</kbd> in any app and start talking.</div>`;
  } else {
    list.innerHTML = recent.slice(0, 5).map(itemHtml).join('');
    wireItems(list);
  }
  $('#onboarding').classList.toggle('hidden', !!settings.firstRunDone);
  $('#ob-hotkey').textContent = settings.hotkey.name;
}

function drawChart(last7) {
  const c = $('#chart');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 780;
  const H = 120;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const max = Math.max(10, ...last7.map((d) => d.words));
  const bw = Math.min(64, (W - 60) / 7 - 18);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#7c5cff');
  grad.addColorStop(1, '#00cec9');
  last7.forEach((d, i) => {
    const x = 30 + i * ((W - 60) / 7) + ((W - 60) / 7 - bw) / 2;
    const h = Math.max(3, (d.words / max) * (H - 38));
    g.fillStyle = d.words > 0 ? grad : 'rgba(255,255,255,0.06)';
    g.beginPath();
    g.roundRect(x, H - 24 - h, bw, h, 4);
    g.fill();
    g.fillStyle = '#a0a6bb';
    g.font = '11px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.fillText(d.day, x + bw / 2, H - 8);
    if (d.words > 0) g.fillText(String(d.words), x + bw / 2, H - 30 - h);
  });
}

// ------------------------------------------------------------------ history
function itemHtml(h) {
  const badge = (h.status === 'injected' ? '<span class="badge injected">typed</span>'
    : h.status === 'copied' ? '<span class="badge copied">copied</span>'
    : '<span class="badge failed">failed</span>')
    + (h.ai ? ' <span class="badge copied">AI</span>' : '');
  const meta = [
    relTime(h.ts),
    h.app ? esc(h.app) : null,
    h.words ? `${h.words} words` : null,
    h.wpm ? `${h.wpm} wpm` : null,
    h.engine ? esc(h.engine) : null,
  ].filter(Boolean).join(' · ');
  return `<div class="item" data-id="${h.id}">
    <div class="item-text" title="Click to expand">${esc(h.text || '(no text)')}</div>
    <div class="item-meta">${badge}<span>${meta}</span><span class="spacer"></span>
      <button class="icon-btn copy" title="Copy">⧉ copy</button>
      <button class="icon-btn del" title="Delete">✕</button>
    </div>
  </div>`;
}

function wireItems(root) {
  root.querySelectorAll('.item').forEach((el) => {
    el.querySelector('.item-text').addEventListener('click', () => el.classList.toggle('expanded'));
    el.querySelector('.copy').addEventListener('click', async () => {
      await window.vox.historyCopy(el.dataset.id);
      toast('Copied to clipboard');
    });
    el.querySelector('.del').addEventListener('click', async () => {
      await window.vox.historyDelete(el.dataset.id);
      el.remove();
    });
  });
}

let searchTimer = null;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderHistory, 180);
});
$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Delete ALL dictation history? This cannot be undone.')) return;
  await window.vox.historyClear();
  renderHistory();
  toast('History cleared');
});

async function renderHistory() {
  const q = $('#search').value;
  const items = await window.vox.historyList(q);
  const list = $('#history-list');
  if (items.length === 0) {
    list.innerHTML = q
      ? `<div class="empty">No results for “${esc(q)}”.</div>`
      : `<div class="empty"><div class="big">🎙️</div>
         Nothing dictated yet.<br/>Hold <kbd>${esc(settings.hotkey.name)}</kbd> in any app and start talking.</div>`;
  } else {
    list.innerHTML = items.map(itemHtml).join('');
    wireItems(list);
  }
}

// ------------------------------------------------------------------ dictionary
async function renderDictionary() {
  const dict = await window.vox.dictGet();
  const chips = $('#boost-chips');
  chips.innerHTML = dict.boostWords.length
    ? dict.boostWords.map((w, i) =>
        `<span class="chip">${esc(w)}<button data-i="${i}" title="Remove">✕</button></span>`).join('')
    : '<span class="dim">No boost words yet.</span>';
  chips.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    dict.boostWords.splice(Number(b.dataset.i), 1);
    await window.vox.dictSet(dict);
    renderDictionary();
  }));

  const rows = $('#repl-rows');
  rows.innerHTML = dict.replacements.length
    ? dict.replacements.map((r, i) =>
        `<div class="repl-row"><b>${esc(r.from)}</b><span class="arrow">→</span>
         <span>${esc(r.to)}</span>
         <button class="icon-btn del" data-i="${i}">✕</button></div>`).join('')
    : '<div class="dim" style="padding:6px 0 10px">No rules yet.</div>';
  rows.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
    dict.replacements.splice(Number(b.dataset.i), 1);
    await window.vox.dictSet(dict);
    renderDictionary();
  }));
}

$('#boost-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#boost-input').value.trim();
  if (!v) return;
  const dict = await window.vox.dictGet();
  if (!dict.boostWords.includes(v)) dict.boostWords.push(v);
  await window.vox.dictSet(dict);
  $('#boost-input').value = '';
  renderDictionary();
  toast('Added — the recognizer will now favor it');
});

$('#repl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = $('#repl-from').value.trim();
  const to = $('#repl-to').value;
  if (!from || !to) return;
  const dict = await window.vox.dictGet();
  dict.replacements.push({ from, to });
  await window.vox.dictSet(dict);
  $('#repl-from').value = ''; $('#repl-to').value = '';
  renderDictionary();
});

// ------------------------------------------------------------------ settings
async function renderSettings() {
  settings = await window.vox.settingsGet();
  appInfo = await window.vox.appInfo();

  $('#hotkey-name').textContent = settings.hotkey.name;
  $('#set-mode').value = settings.hotkeyMode;
  $('#set-inject').value = settings.injectionMode;
  $('#set-restore').checked = settings.restoreClipboard;
  $('#set-fillers').checked = settings.removeFillers;
  $('#set-commands').checked = settings.spokenCommands;
  $('#set-autostop').checked = settings.autoStopSilence;
  $('#set-idleunload').checked = settings.idleUnload;
  $('#set-retention').value = String(settings.historyRetentionDays || 0);
  $('#set-enabled').checked = settings.enabled;
  $('#set-sounds').checked = settings.sounds;
  $('#set-login').checked = settings.launchAtLogin;

  await fillMics();
  await fillLanguages();
  await renderModels();
  await fillAiEdits();

  $('#about-version').textContent = `${appInfo.version} (Electron ${appInfo.electron})`;
  $('#about-engine').textContent = appInfo.engine;
  $('#about-data').textContent = appInfo.userDataDir;
}

async function fillMics() {
  const sel = $('#set-mic');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    sel.innerHTML = '<option value="default">System default</option>' +
      mics.filter((m) => m.deviceId && m.deviceId !== 'default')
        .map((m, i) => `<option value="${esc(m.deviceId)}">${esc(m.label || `Microphone ${i + 1}`)}</option>`)
        .join('');
    sel.value = settings.micDeviceId;
    if (sel.selectedIndex < 0) sel.value = 'default';
    const labeled = mics.some((m) => m.label);
    $('#mic-note').textContent = labeled ? 'Which microphone to record from' : 'Device labels appear after first dictation';
  } catch (_) {
    sel.innerHTML = '<option value="default">System default</option>';
  }
}

async function fillLanguages() {
  const langs = await window.vox.languagesList();
  const sel = $('#set-lang');
  const englishOnly = settings.model.endsWith('.en');
  sel.innerHTML = langs.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  sel.value = englishOnly ? 'en' : settings.language;
  sel.disabled = englishOnly;
  $('#lang-note').textContent = englishOnly
    ? 'The active model is English-only — pick a multilingual model below to change language'
    : 'Spoken language (auto-detect works well for mixed use)';
}

async function renderModels() {
  const models = await window.vox.modelsList();
  const wrap = $('#model-list');
  wrap.innerHTML = models.map((m) => {
    let action;
    if (m.downloading) {
      action = `<div class="progress" data-prog="${m.id}"><div></div></div>
        <button class="btn ghost small cancel" data-id="${m.id}">Cancel</button>`;
    } else if (m.active) {
      action = '<span class="badge injected">Active</span>';
    } else if (m.installed) {
      action = `<button class="btn ghost small use" data-id="${m.id}">Use</button>`;
    } else {
      action = `<button class="btn small dl" data-id="${m.id}">Download</button>`;
    }
    return `<div class="model-row">
      <div class="model-info"><b>${esc(m.label)}</b>${m.recommended ? ' <span class="badge copied">recommended</span>' : ''}
        <div class="dim">${esc(m.desc)}</div></div>
      <span class="model-size">${m.mb} MB</span>
      <div class="model-act row-gap" style="justify-content:flex-end">${action}</div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.dl').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    renderModelsSoon();
    const res = await window.vox.modelsDownload(b.dataset.id);
    if (!res.ok && res.error !== 'cancelled') toast(`Download failed: ${res.error}`);
    renderModels();
  }));
  wrap.querySelectorAll('.cancel').forEach((b) => b.addEventListener('click', async () => {
    await window.vox.modelsCancel(b.dataset.id);
  }));
  wrap.querySelectorAll('.use').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const res = await window.vox.modelsActivate(b.dataset.id);
    if (!res.ok) toast(`Could not activate: ${res.error}`);
    else toast(`Model active (engine: ${res.engine})`);
    settings = await window.vox.settingsGet();
    await renderModels();
    await fillLanguages();
  }));
}
let modelsSoonTimer = null;
function renderModelsSoon() {
  clearTimeout(modelsSoonTimer);
  modelsSoonTimer = setTimeout(renderModels, 120);
}

// ------------------------------------------------------------------ AI edits
let aiMeta = null;
async function fillAiEdits() {
  aiMeta = aiMeta || await window.vox.aiMeta();
  $('#set-ai').checked = settings.aiEdits;
  $('#set-ai-key').value = settings.aiApiKey || '';

  const provider = aiMeta.providers[settings.aiProvider] || aiMeta.providers.groq;
  const modelSel = $('#set-ai-model');
  modelSel.innerHTML = provider.models.length
    ? provider.models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')
    : `<option value="${esc(settings.aiModel)}">${esc(settings.aiModel)}</option>`;
  modelSel.value = settings.aiModel;
  if (modelSel.selectedIndex < 0) modelSel.selectedIndex = 0;

  const styleSel = $('#set-ai-style');
  styleSel.innerHTML = Object.entries(aiMeta.styles)
    .map(([id, st]) => `<option value="${esc(id)}">${esc(st.label)}</option>`).join('');
  styleSel.value = settings.aiStyle;
  if (styleSel.selectedIndex < 0) styleSel.value = 'clean';
  updateAiHints();
}

function updateAiHints() {
  const st = aiMeta && aiMeta.styles[$('#set-ai-style').value];
  $('#ai-style-hint').textContent = st ? st.hint : '';
  $('#ai-enable-note').textContent =
    settings.aiEdits && !settings.aiApiKey
      ? 'Add your free API key below to activate'
      : 'Needs the API key below';
}

$('#set-ai').addEventListener('change', async (e) => {
  settings = await window.vox.settingsSet({ aiEdits: e.target.checked });
  updateAiHints();
  toast(!settings.aiEdits ? 'AI edits off'
    : settings.aiApiKey ? 'AI edits on' : 'AI edits on — add your API key below');
});
$('#set-ai-key').addEventListener('change', async (e) => {
  settings = await window.vox.settingsSet({ aiApiKey: e.target.value.trim() });
  e.target.value = settings.aiApiKey;
  updateAiHints();
  toast(settings.aiApiKey ? 'API key saved (encrypted)' : 'API key removed');
});
bindSetting('#set-ai-model', 'aiModel');
$('#set-ai-style').addEventListener('change', async (e) => {
  settings = await window.vox.settingsSet({ aiStyle: e.target.value });
  updateAiHints();
  toast('Saved');
});
$('#ai-key-link').addEventListener('click', (e) => { e.preventDefault(); window.vox.aiKeyUrl(); });
$('#ai-test').addEventListener('click', async () => {
  const btn = $('#ai-test');
  const note = $('#ai-test-note');
  if (!settings.aiApiKey) { note.textContent = 'Add an API key first'; return; }
  btn.disabled = true;
  note.textContent = 'Testing…';
  const r = await window.vox.aiTest();
  btn.disabled = false;
  note.textContent = r.ok ? `✓ Connected — ${r.model} replied in ${r.ms} ms` : `✗ ${r.error}`;
});

$('#hotkey-change').addEventListener('click', async () => {
  const btn = $('#hotkey-change');
  const kbd = $('#hotkey-name');
  btn.disabled = true;
  kbd.textContent = 'Press any key… (Esc cancels)';
  const key = await window.vox.hotkeyCapture();
  settings = await window.vox.settingsGet();
  kbd.textContent = settings.hotkey.name;
  btn.disabled = false;
  toast(key ? `Hotkey set to ${key.name}` : 'Cancelled');
});

function bindSetting(sel, key, prop) {
  $(sel).addEventListener('change', async (e) => {
    const value = prop === 'checked' ? e.target.checked : e.target.value;
    settings = await window.vox.settingsSet({ [key]: value });
    if (key === 'model' || key === 'language') await fillLanguages();
    toast('Saved');
  });
}
bindSetting('#set-mode', 'hotkeyMode');
bindSetting('#set-inject', 'injectionMode');
bindSetting('#set-restore', 'restoreClipboard', 'checked');
bindSetting('#set-fillers', 'removeFillers', 'checked');
bindSetting('#set-commands', 'spokenCommands', 'checked');
bindSetting('#set-autostop', 'autoStopSilence', 'checked');
bindSetting('#set-idleunload', 'idleUnload', 'checked');
bindSetting('#set-enabled', 'enabled', 'checked');
bindSetting('#set-sounds', 'sounds', 'checked');
bindSetting('#set-login', 'launchAtLogin', 'checked');
bindSetting('#set-lang', 'language');
$('#set-retention').addEventListener('change', async (e) => {
  settings = await window.vox.settingsSet({ historyRetentionDays: Number(e.target.value) });
  toast('Saved');
});
$('#export-history').addEventListener('click', async () => {
  const r = await window.vox.historyExport();
  if (r.ok) toast(`Exported ${r.count} dictations`);
  else if (!r.canceled) toast(r.error || 'Export failed');
});
$('#set-mic').addEventListener('change', async (e) => {
  settings = await window.vox.settingsSet({ micDeviceId: e.target.value });
  toast('Microphone saved');
});
$('#open-logs').addEventListener('click', () => window.vox.openLogs());

// ------------------------------------------------------------------ push events
window.vox.on('models:progress', (p) => {
  const bar = document.querySelector(`[data-prog="${p.id}"] > div`);
  if (bar) bar.style.width = `${p.pct}%`;
  if (p.done) renderModels();
});
window.vox.on('history:changed', () => {
  if ($('#page-home').classList.contains('active')) renderHome();
  if ($('#page-history').classList.contains('active')) renderHistory();
});
window.vox.on('settings:changed', (s) => { settings = s; });
window.vox.on('engine:status', (s) => {
  $('#engine-chip').textContent = `engine: ${s.engine}`;
  if (appInfo) $('#about-engine').textContent = s.engine;
});
window.vox.on('onboarding:done', () => {
  $('#onboarding').classList.add('hidden');
  toast('First dictation done — you’re set! 🎉');
});

// ------------------------------------------------------------------ boot
(async function boot() {
  settings = await window.vox.settingsGet();
  appInfo = await window.vox.appInfo();
  $('#version').textContent = `v${appInfo.version}`;
  $('#engine-chip').textContent = `engine: ${appInfo.engine}`;
  renderHome();
})();

'use strict';

/* Overlay renderer: owns the microphone. Records 16 kHz mono Float32 via an
 * AudioWorklet, draws the live waveform, plays feedback tones, and reports
 * the finished take to the main process. */

const pill = document.getElementById('pill');
const label = document.getElementById('label');
const timerEl = document.getElementById('timer');
const wave = document.getElementById('wave');
const wctx = wave.getContext('2d');

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let rec = null;          // active recording session
let demoTimer = null;
let elapsedTimer = null;
let levels = new Array(30).fill(0.05);

// ------------------------------------------------------------------ UI state
function setState(state, detail, demo) {
  document.body.className = state;
  pill.classList.remove('hidden');
  label.textContent =
    detail ||
    ({ listening: 'Listening…', processing: 'Transcribing…' }[state] || '');
  if (state === 'listening') {
    startTimer();
    if (demo) startDemoBars();
  } else {
    stopTimer();
    stopDemoBars();
  }
  if (state === 'processing' || state === 'listening') drawBars();
}

window.vox.onUiState((d) => {
  if (d.pulse) { pulse(); return; }
  setState(d.state, d.detail, d.demo);
  if (d.detail === 'auto-stop soon' && timerEl) timerEl.classList.add('warn');
});

function pulse() {
  pill.style.transform = 'translateX(-50%) scale(1.04)';
  setTimeout(() => { pill.style.transform = 'translateX(-50%)'; }, 140);
}

function startTimer() {
  timerEl.classList.remove('warn');
  const t0 = Date.now();
  stopTimer();
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  timerEl.textContent = '0:00';
}
function stopTimer() { clearInterval(elapsedTimer); elapsedTimer = null; }

// ------------------------------------------------------------------ waveform
function drawBars() {
  const W = wave.width, H = wave.height;
  wctx.clearRect(0, 0, W, H);
  const n = levels.length;
  const bw = 3, gap = 2;
  const grad = wctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#7c5cff');
  grad.addColorStop(1, '#00cec9');
  wctx.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, levels[i] * 9);
    const h = Math.max(3, v * (H - 6));
    const x = i * (bw + gap);
    const y = (H - h) / 2;
    wctx.beginPath();
    wctx.roundRect(x, y, bw, h, 1.5);
    wctx.fill();
  }
}

function pushLevel(v) {
  levels.push(v);
  if (levels.length > 30) levels.shift();
  if (!reduceMotion) requestAnimationFrame(drawBars);
}

function startDemoBars() {
  stopDemoBars();
  let t = 0;
  demoTimer = setInterval(() => {
    t += 0.35;
    pushLevel(0.04 + 0.05 * Math.abs(Math.sin(t)) + Math.random() * 0.05);
  }, 50);
}
function stopDemoBars() { clearInterval(demoTimer); demoTimer = null; }

// ------------------------------------------------------------------ tones
function tone(freq, ms, gain) {
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    g.gain.setValueAtTime(0, ac.currentTime);
    g.gain.linearRampToValueAtTime(gain || 0.07, ac.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + ms / 1000);
    osc.connect(g).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + ms / 1000 + 0.02);
    osc.onended = () => ac.close();
  } catch (_) { /* sound is never critical */ }
}

// ------------------------------------------------------------------ recording
async function startRecording(cfg) {
  await stopRecording(true); // safety: never two sessions
  const session = {
    gen: cfg.gen,
    chunks: [],
    totalSamples: 0,
    sumSquares: 0,
    stream: null,
    ctx: null,
    node: null,
    stopped: false,
    sounds: cfg.sounds,
    autoStop: cfg.autoStop || { enabled: false },
    startedAt: Date.now(),
    lastSpeechAt: 0,
    autoStopFired: false,
  };
  rec = session;
  try {
    const constraints = {
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };
    if (cfg.deviceId && cfg.deviceId !== 'default') {
      constraints.audio.deviceId = { exact: cfg.deviceId };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
        delete constraints.audio.deviceId; // chosen mic gone → default
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else throw e;
    }
    if (session !== rec || session.stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
    session.stream = stream;

    stream.getAudioTracks().forEach((t) => {
      t.onended = () => {
        if (session === rec && !session.stopped) {
          window.vox.recError('Microphone connection lost');
          stopRecording(true);
        }
      };
    });

    const ctx = new AudioContext({ sampleRate: 16000 });
    session.ctx = ctx;
    session.sampleRate = ctx.sampleRate;
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    if (session !== rec || session.stopped) { cleanup(session); return; }
    const src = ctx.createMediaStreamSource(session.stream);
    const node = new AudioWorkletNode(ctx, 'pcm-collector', {
      numberOfInputs: 1, numberOfOutputs: 0,
    });
    session.node = node;
    node.port.onmessage = (ev) => {
      if (session !== rec || session.stopped) return;
      session.chunks.push(ev.data.samples);
      session.totalSamples += ev.data.samples.length;
      session.sumSquares += ev.data.rms * ev.data.rms * ev.data.samples.length;
      pushLevel(ev.data.rms);

      // Toggle-mode auto-finish: once speech has happened, a sustained pause
      // ends the take; if nothing is ever said, give up after leadMs.
      const a = session.autoStop;
      if (a.enabled && !session.autoStopFired) {
        const now = Date.now();
        if (ev.data.rms >= a.speechRms) session.lastSpeechAt = now;
        const spoke = session.lastSpeechAt > 0;
        if ((spoke && now - session.lastSpeechAt >= a.silenceMs) ||
            (!spoke && now - session.startedAt >= a.leadMs)) {
          session.autoStopFired = true;
          window.vox.recAutoStop(session.gen);
        }
      }
    };
    src.connect(node);
    if (session.sounds) tone(950, 90);
  } catch (e) {
    if (session === rec) {
      window.vox.recError(`${e.name || 'Error'}: ${e.message || e}`);
      cleanup(session);
      rec = null;
    }
  }
}

function cleanup(session) {
  try { session.node && session.node.port && (session.node.port.onmessage = null); } catch (_) {}
  try { session.stream && session.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { session.ctx && session.ctx.state !== 'closed' && session.ctx.close(); } catch (_) {}
}

// Single finish path used by real dictation AND the selftest, so the selftest
// always exercises exactly what production runs.
async function finishSession(session) {
  session.stopped = true;
  if (rec === session) rec = null;
  // tiny drain so the last worklet blocks arrive
  await new Promise((r) => setTimeout(r, 60));
  cleanup(session);
  const rms = session.totalSamples > 0
    ? Math.sqrt(session.sumSquares / session.totalSamples)
    : 0;
  const durationMs = Math.round((session.totalSamples / (session.sampleRate || 16000)) * 1000);
  return { rms, durationMs, samples: session.totalSamples, sampleRate: session.sampleRate || 16000 };
}

async function stopRecording(discard) {
  const session = rec;
  if (!session || session.stopped) return;
  const stats = await finishSession(session);
  if (discard) return;
  if (session.sounds) tone(640, 80);

  const pcm = new Float32Array(session.totalSamples);
  let off = 0;
  for (const c of session.chunks) { pcm.set(c, off); off += c.length; }
  window.vox.recDone({
    gen: session.gen,
    pcm: pcm.buffer,
    sampleRate: stats.sampleRate,
    durationMs: stats.durationMs,
    rms: stats.rms,
  });
}

window.vox.onRecStart((cfg) => startRecording(cfg));
window.vox.onRecStop((d) => {
  const wasSounds = rec && rec.sounds;
  stopRecording(d && d.discard);
  if (d && d.discard && wasSounds) tone(300, 70, 0.05);
});

// ------------------------------------------------------------------ selftest
window.vox.onSelftestMic(async (cfg) => {
  try {
    await startRecording({ gen: -999, deviceId: cfg.deviceId, sounds: false });
    if (!rec) throw new Error('recording did not start (see rec:error)');
    await new Promise((r) => setTimeout(r, cfg.ms || 1000));
    const stats = await finishSession(rec);
    window.vox.selftestMicResult({
      ok: stats.samples > 0,
      samples: stats.samples,
      sampleRate: stats.sampleRate,
      rms: stats.rms,
      error: stats.samples > 0 ? null : 'no samples captured',
    });
  } catch (e) {
    window.vox.selftestMicResult({ ok: false, samples: 0, rms: 0, error: String(e.message || e) });
  }
});

drawBars();

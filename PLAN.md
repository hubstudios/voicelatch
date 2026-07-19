# VoiceLatch — Technical Plan

## Stack (all decisions validated empirically on the dev machine)
- **Electron 37** (vanilla JS/HTML/CSS, no bundler — fewer moving parts, nothing to misconfigure).
- **uiohook-napi** for the global keyboard hook (prebuilt N-API binary for win32-x64 confirmed
  present; Electron `globalShortcut` can't detect key-*up*, which hold-to-talk requires).
- **whisper.cpp v1.9.1** prebuilt Windows CPU binaries.
  - Primary engine: `whisper-server.exe` kept warm (model loaded once at app start).
    Measured: CLI cold spawn ≈ 1.16 s *fixed* cost per utterance (model load dominates);
    warm server eliminates it. Verified response shape: `{"text":"..."}` from
    `POST /inference` (multipart `file` + `response_format=json`).
  - **Crash lesson (validated):** server needs (a) app-local MSVC runtime DLLs
    (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` — system copy here was 2019-era
    and the server AVs in it), (b) `cwd` = binary dir, (c) an existing `--public` dir, and
    `-nfa` (no flash-attn on CPU). All four are applied.
  - **Fallback engine: `whisper-cli.exe`** spawn-per-utterance (proven word-perfect, 1.16 s
    warm-cache). Auto-selected if the server fails health-check twice; auto-respawn on death.
  - ggml picks the best CPU kernel DLL at runtime (sse42→icelake variants ship in the zip),
    so the same bundle runs on any x64 CPU.
- **Injection helper: `injector.exe`** — small C# program compiled at build time with the
  csc.exe that ships inside every Windows 10/11 (.NET Framework 4.x). Commands:
  - `paste` — synthesize Ctrl+V via SendInput (clipboard set/restore done by Electron main).
  - `type` — read UTF-8 text from stdin, inject as KEYEVENTF_UNICODE SendInput events
    (clipboard untouched; surrogate pairs handled; chunked).
  - `fginfo` — print foreground window title + process name (history "which app" metadata).
  - `pastetest` / `typetest` — self-contained round-trip test: opens its own Win32 textbox,
    focuses it, injects, reads the textbox back, prints result (used by selftest).
- **Packaging: electron-builder NSIS one-click per-user installer** for any Windows 10/11 x64 PC:
  - `extraResources`: trimmed whisper bin (whisper-cli, whisper-server, ggml*.dll, whisper.dll,
    + the 3 MSVC runtime DLLs), `injector.exe`, `ggml-base.en.bin` (offline out-of-the-box),
    empty `public/` dir.
  - Bundles official `vc_redist.x64.exe`, run silently by the installer (standard practice;
    covers machines where even whisper-cli would fail).
  - Unsigned → SmartScreen warning on first run on new PCs (documented; signing costs money).
- **Dev-machine note:** Electron/Playwright zip extraction deadlocks on this PC; Electron was
  extracted manually from `%LOCALAPPDATA%\electron\Cache` + `path.txt` written by hand.

## Runtime file resolution (multi-PC + dev)
Search order for whisper bin / models / injector:
1. `%APPDATA%\VoiceLatch\` (`models\` downloaded in-app; future upgrades)
2. `process.resourcesPath` (packaged installer resources)
3. `<repo>/runtime/` (dev mode)
User data (settings.json, history.json, logs, temp WAVs) always in `%APPDATA%\VoiceLatch\`.
JSON writes are atomic (tmp + rename). History capped at 5000 entries.

## Process architecture
```
Electron main
├─ tray (icon, menu: dashboard / enable / start-with-windows / quit), single-instance
├─ hotkeys.js      uiohook: hold (keydown→start, keyup→stop) & toggle modes,
│                  press-to-capture for rebinding, suppressed while injecting
├─ overlay window  frameless, transparent, alwaysOnTop, skipTaskbar, focusable:false
│                  (never steals focus). Owns getUserMedia recording:
│                  AudioContext({sampleRate:16000}) + AudioWorklet → Float32 PCM
│                  → IPC to main on stop; draws live waveform locally; WebAudio beeps.
├─ recorder→wav.js Float32 → 16-bit mono 16 kHz WAV temp file
├─ transcriber.js  engine=auto: warm server (respawn on death, health-check) | cli fallback;
│                  language + dictionary boost words via launch flags (--prompt);
│                  any engine-affecting setting change → transparent respawn
├─ postprocess.js  trim → filler removal (opt) → user find/replace rules → whitespace,
│                  capitalize first letter
├─ injector.js     clipboard save → write text → injector.exe paste → restore (or type mode)
├─ store.js        settings + history + dictionary (defaults, migration-tolerant merge)
└─ dashboard win   Home stats / History / Dictionary / Settings, hidden-not-closed
```
Dictation state machine: `idle → listening → processing → injecting → flash(success|nospeech|error) → idle`.
Min utterance 0.5 s (discard taps), max 10 min (auto-stop). Near-silence (RMS < threshold) → "No speech detected".

## IPC contract (contextBridge, both preloads; no nodeIntegration)
- overlay: `rec:start {deviceId}` (main→R), `rec:stop`, `rec:done {pcmBuffer, durationMs, rms}` (R→main),
  `rec:error {msg}`, `ui:state {state, detail}` (main→R)
- dashboard: `settings:get/set`, `history:list/delete/clear`, `dict:get/set`, `stats:get`,
  `models:list/download/cancel/activate` (+`models:progress` events), `hotkey:capture` (+event),
  `mics:list` (renderer enumerates, main stores), `app:info`
- selftest: `selftest:*` internal channel for the smoke harness

## Model registry (in-app downloads → %APPDATA%\VoiceLatch\models)
tiny.en / tiny / base.en (bundled) / base / small.en / small / large-v3-turbo,
from `huggingface.co/ggerganov/whisper.cpp` with progress + size verification.
Language: en / auto / ~15 named languages (multilingual models only; UI enforces).

## Test plan (maps to SPEC acceptance criteria)
1. `scripts/tests/unit.test.js` — WAV encoder bytes, postprocess rules, dictionary edge cases.
2. `scripts/tests/accuracy.test.js` — Windows TTS speaks 3 known sentences → engine → ≥70%
   word overlap (both server and cli engines).
3. `scripts/tests/injector.test.js` — pastetest + typetest round-trip incl. punctuation,
   unicode (é, ü, →), emoji-free (SendInput unicode handles BMP; astral via surrogates).
4. `scripts/tests/pipeline.test.js` — WAV → transcriber → postprocess → clipboard verified.
5. `electron . --selftest` — real app boot: uiohook active, tray, overlay+dashboard loaded,
   1 s real mic capture (valid WAV + RMS reported), engine health, screenshots to
   `selftest-artifacts/`, machine-readable report.json, exit code.
6. Packaged smoke — after NSIS build: install → launch → `--selftest` against installed copy.
`scripts/selftest.js` orchestrates all of the above; any failure = non-zero exit.

## Risks & mitigations
- Mic privacy blocked on a PC → precise error state on overlay + settings hint (Windows
  Settings → Privacy → Microphone → desktop apps).
- Hotkey collision (game/RDP) → rebindable; uiohook failure → toggle via tray still works.
- Server flakiness on unknown PCs → cli fallback is always available and tested.
- Long text paste vs slow apps → configurable restore delay; type mode as escape hatch.
- Elevated-window injection (admin apps) → Windows blocks cross-elevation input by design;
  detected via injector `fginfo` elevation flag → clipboard fallback + clear flash.

## Build tiers (order of implementation — protects the core loop)
- **Tier 1 (the product):** hotkey → capture → transcribe → post-process → inject, overlay
  states, tray, settings/history persistence, selftest + E2E tests.
- **Tier 2 (the product polish):** dashboard pages (stats, history UI, dictionary, model
  manager, hotkey capture UI), onboarding, installer.

## GSTACK REVIEW REPORT
_Ran via /autoplan, fully automatic per user directive. Codex CLI absent → all phases
`[subagent-only]` (independent Claude reviewer + primary synthesis). 4 phases: CEO, Design,
Eng, DX. Full findings in the four reviewer transcripts; adopted deltas below._

### Consensus (primary ⊕ independent voice)
| Phase | Verdict | Key agreement | Disagreement → resolution |
|---|---|---|---|
| CEO | ship-with-changes | clipboard data-loss + missing chained E2E are blockers → both fixed in design | CEO: cut models/stats/multilang scope → **overridden by user's full-scope directive**; build tiers added instead |
| Design | needs design pass | injection-failed state, onboarding, tokens, empty states → all adopted | overlay anchor: foreground-window display vs cursor display → cursor display (no native code, close proxy) |
| Eng | sound architecture, 18 defects | all criticals adopted (see deltas) | resident injector process → deferred, measure spawn cost first |
| DX | strong engine, unwritten human surface | README, setup.js spec, structured logs, View-logs → adopted | proactive mic *activation* probe → replaced with permissions.query (no mic light) |

### Adopted design deltas (from findings)
1. Injection safety: capture foreground hwnd+elevation at record-stop; re-check before
   inject; mismatch/elevated → **no injection**, text stays on clipboard, "Copied — press
   Ctrl+V" flash. Injection failure can never lose text.
2. Clipboard restore preserves text/html/image formats; restore skipped if the user changed
   the clipboard during processing; adaptive delay (default 350 ms).
3. Hotkeys: keydown transition filtering (auto-repeat immune), injecting-guard + 200 ms
   grace (no self-trigger loops), Esc cancels, "dictation off" feedback flash.
4. Overlay renderer death → `render-process-gone` handler recreates window, resets state.
5. Transcriber: single-flight queue; duration-scaled timeouts (30 s + 3× audio);
   verbose_json → `no_speech_prob`/`avg_logprob` hallucination gate + quiet-clip blocklist
   (both engines); respawn awaits in-flight request; EADDRINUSE retry with fresh port.
6. Quit ordering: stop hook → abort recording → kill server → flush store → quit.
7. Installer: NSIS one-click per-user, **no vc_redist** (app-local MSVC DLLs beside every
   exe — validated); nsis+extraResources config added; uiohook asarUnpack load asserted.
8. Model downloads: `.part` + size verification + atomic rename; corrupt-model startup check.
9. Type mode: `\n`→VK_RETURN (already built); empty-after-postprocess → nospeech, never inject "".
10. Max-duration warning at 9:30, auto-stop 10:00; mic `track.onended` → error state.
11. UI: design tokens (8 px grid, 160 ms motion, ≥4.5:1 contrast), pill 300×56 r16 bottom-28
    on cursor display, empty states with copy, sidebar nav, grouped settings, focus rings,
    prefers-reduced-motion, first-run onboarding banner + tray tip.
12. Tests added: chained E2E (synthetic hotkey → real app → real mic → inject into spawned
    Notepad, read back), server-kill-mid-request fallback, corrupt model, clipboard-format
    survival, long-clip (90 s) timeout scaling, clean-PC path resolution, state-machine table.

### Decision audit trail (auto-decisions, principle-tagged)
| # | Phase | Decision | Class | Principle |
|---|---|---|---|---|
| 1 | CEO | Keep full product scope; tier build order instead of cutting | USER-DIRECTIVE override of both-voice recommendation | P1 completeness |
| 2 | CEO | Chained E2E via synthetic hotkey + speaker-loopback best-effort + Notepad readback | Mechanical | P1 |
| 3 | CEO | SHA-256 pinning deferred; size+source pinning + atomic rename now | Taste | P3 pragmatic |
| 4 | Design | Cursor-display anchoring over foreground-window-display | Taste | P5 explicit |
| 5 | Design | Exclusive-fullscreen overlay: document, don't engineer | Taste | P3 |
| 6 | Eng | Drop vc_redist from installer (app-local DLLs suffice) | Mechanical | P5 |
| 7 | Eng | Resident injector deferred; measure spawn cost in selftest | Taste | P3 |
| 8 | Eng | History cap 2000 entries / 5 k chars each, debounced atomic writes + EPERM retry | Mechanical | P3 |
| 9 | DX | permissions.query mic check (no activation) over probe recording | Mechanical | P5 |
| 10 | DX | Uninstall keeps %APPDATA% data; documented in README | Taste | P6 |

_Prior-art note (CEO F8): open local-whisper dictation tools exist (e.g. Handy). Building
from scratch is deliberate: the user's goal is learning + a complete dictation feature set
(overlay UX, history/stats, dictionary) that thin tools don't provide._

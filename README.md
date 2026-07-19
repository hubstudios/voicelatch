# VoiceLatch

Local, private voice dictation for Windows. Hold a key anywhere, speak, release —
your words are typed into whatever app you're using, at the cursor. Runs **100%
on your PC**: no account, no API key, no cloud, audio never leaves the machine.
(One optional, off-by-default exception: the **AI edits** mode below sends
finished *text* — never audio — to a free cloud AI to polish it. Everything
else works with it off.)

- **Engine:** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (bundled), warm
  in RAM for fast turnaround, with an automatic CLI fallback if the server engine
  ever fails on a machine.
- **Injection:** native Windows `SendInput` helper — paste mode (default, clipboard
  is saved and restored) or per-character type mode.
- **Extras:** live-waveform overlay pill, history + stats dashboard, custom
  dictionary (boost words + auto-replacements), filler-word removal, spoken
  layout commands, toggle-mode auto-finish on silence, per-key rebindable
  hotkey, tray app, launch-at-login, history export (txt/csv) + retention
  auto-purge, idle memory unload, optional AI rewrite of each dictation
  (Groq free tier; strictly fail-open).

> Prior art note: other local-whisper hotkey tools exist (e.g. Handy). VoiceLatch was
> built from scratch deliberately — for a complete dictation experience (overlay,
> history/stats, dictionary) and as a learning project.

---

## Using it (any Windows 10/11 x64 PC)

1. Copy `dist/VoiceLatch-Setup-<version>.exe` to the PC and run it.
   *The installer is unsigned, so SmartScreen will warn on a new PC: click
   **More info → Run anyway**. Per-user install, no admin needed.*
2. Launch VoiceLatch (desktop shortcut). It lives in the system tray.
3. Click into any text field, **hold Right Ctrl**, speak, release. Text appears
   at the cursor after a moment.
4. Press **Esc** while recording to cancel. Double-click the tray icon for the
   dashboard (history, dictionary, settings, models).

Works fully offline out of the box (the compressed English `base.en-q5_1`
model is bundled — benchmarked as fast as ~1.2 s per utterance with identical
accuracy to the uncompressed original). Other model sizes and languages
download from the dashboard → Settings → Model.

### Spoken commands (on by default; Settings → Output)
Say these **after a sentence** (they only convert following punctuation, so
prose like "a new line of products" is untouched):
- “new line” → line break · “new paragraph” → blank line · “bullet point” → •
In toggle mode, recording auto-finishes ~2 s after you stop talking
(Settings → Dictation to disable).

### AI edits (optional, off by default; Settings → AI edits)
Rewrites each dictation with an LLM before it is typed — fixes grammar, drops
false starts, and can restyle (Clean up / Formal / Casual / Email-ready).
- Uses **Groq's free API tier** (no credit card; ~14k requests/day — far more
  than any dictation habit). Get a key at
  [console.groq.com/keys](https://console.groq.com/keys), paste it into
  Settings → AI edits, hit **Test**.
- **Privacy:** only the finished *text* of a dictation leaves your PC, never
  audio, and only while the toggle is on. Groq states it does not train on API
  data. The key is stored encrypted with Windows DPAPI (your user account).
- **Fail-open by design:** if the service is slow (8 s budget), down, or
  returns junk, VoiceLatch types your raw transcript instead — a dictation is
  never lost or delayed indefinitely. AI-polished entries show an **AI** badge
  in History.
- Power users: any OpenAI-compatible endpoint works — set `aiProvider:
  "custom"`, `aiBaseUrl`, and `aiModel` in `%APPDATA%\VoiceLatch\settings.json`
  (e.g. a local `llama-server` for fully offline rewriting).

### Good to know
- **First press feels slow?** The engine warms up at app start; after that,
  release-to-text is typically 2–4 s on a modern laptop CPU.
- **Admin windows** (elevated apps): Windows forbids apps from typing into them.
  VoiceLatch detects this, copies your text instead, and tells you to press Ctrl+V.
- **Focus changed while transcribing?** VoiceLatch refuses to type into the wrong
  window — your text is on the clipboard instead ("Copied — press Ctrl+V").
- **Fullscreen-exclusive games** may hide the overlay; dictation still works.
- **Mic blocked?** Windows Settings → Privacy & security → Microphone → allow
  desktop apps.
- Uninstalling keeps your history/settings in `%APPDATA%\VoiceLatch` (delete that
  folder manually if you want a clean slate; downloaded models live there too).

## Code signing policy

This project uses free code signing for open-source projects provided by
[SignPath.io](https://signpath.io), with a certificate from the
[SignPath Foundation](https://signpath.org) (application in progress; releases
are unsigned until it completes).
- Team roles: [Naveed (naveedhubstudios-max)](https://github.com/naveedhubstudios-max)
  is the author, reviewer, and release approver (single-maintainer project).
- Privacy: VoiceLatch transmits no data off your PC, with one opt-in exception —
  the off-by-default **AI edits** mode sends the finished dictation *text*
  (never audio) to the AI provider you configure. There is no telemetry.

---

## Developing / maintaining

```bash
npm install         # Electron + uiohook-napi (+ electron-builder)
npm run setup       # downloads whisper v1.9.1 binaries + models (pinned URLs),
                    # deploys app-local MSVC runtime DLLs, compiles the C#
                    # injector with Windows' built-in csc.exe, generates icons
npm start           # run the app from source
npm run selftest    # FULL verification suite (see below)
npm run dist        # stage payload + build NSIS installer + win-unpacked
```

`npm run selftest` runs, in order: unit tests (WAV encoder, post-processing,
state-machine table) → injector keystroke round-trips (opens small test windows)
→ transcription accuracy with generated TTS speech on both engines → engine
failure drills (server killed mid-session, corrupt model) → speech→keystrokes
pipeline → in-app smoke of the real app (hook, tray, real mic capture,
screenshots) → a chained E2E that presses the hotkey synthetically, plays speech
through the speakers, and verifies the text lands in a real Notepad window.
**It steals focus briefly and plays audio.** Artifacts land in
`selftest-artifacts/` (report.json, summary.json, screenshots, e2e log).

### Where things live
- `src/main/` — Electron main: `statemachine.js` (pure, unit-tested),
  `transcriber.js` (warm whisper-server + CLI fallback), `hotkeys.js` (uiohook),
  `injector.js` (clipboard + helper orchestration), `store.js`, `models.js`,
  `aiedit.js` (optional OpenAI-compatible rewrite client — fail-open,
  DPAPI-encrypted key, local mock coverage in the unit suite).
- `src/renderer/overlay/` — the pill: recording (AudioWorklet, 16 kHz mono),
  waveform, tones. `src/renderer/dashboard/` — Home/History/Dictionary/Settings.
- `native/injector.cs` — SendInput helper (paste/type/fginfo/round-trip tests).
  Compiled by `setup.js`; no toolchain needed beyond stock Windows.
- `runtime/` — dev-machine binaries + models (gitignored, rebuilt by `setup.js`).
  Packaged builds resolve the same files from the installer's `resources/`
  directory, and `%APPDATA%\VoiceLatch` always wins (see `src/main/paths.js`).

### Troubleshooting
- Logs: `%APPDATA%\VoiceLatch\logs\voicelatch.log` (also dashboard → Settings → View
  logs). Every dictation logs state transitions, engine used, and timings; the
  last failed take is kept as `%APPDATA%\VoiceLatch\tmp\last-failed.wav`.
- "Transcription failed" → check the log; commonest causes are a corrupt model
  (Settings → Model → re-download) and antivirus quarantining `whisper-*.exe`.
- whisper-server crashes at startup on old machines → the app auto-falls back to
  the CLI engine (slower but identical accuracy). The app-local MSVC DLLs
  shipped beside the exes prevent the known 2019-runtime crash.
- Electron/Playwright-style zip extraction hangs on some Windows machines; if
  `npm install` leaves `node_modules/electron/dist` empty, extract the zip from
  `%LOCALAPPDATA%\electron\Cache` manually with `tar -xf` and write `path.txt`
  containing `electron.exe` (setup.js's whisper downloads already use tar).

### Known limitations (v1)
- No real-time streaming preview (transcription happens on release).
- AI edits needs internet + a (free) Groq key while enabled; it adds the
  provider's round-trip (~0.5–2 s) to each dictation.
- Unsigned installer (SmartScreen warning) — code-signing costs money.
- Elevated windows receive clipboard fallback, not direct typing (OS rule).
- Latency is CPU-bound: roughly 1.5–3 s per utterance with `base.en-q5_1` on a
  laptop (v1.2.1 cut ~25–30% via flash-attention, full-core threading, and an
  in-memory audio hot path). The `Tiny · English (compressed)` model is ~2×
  faster again if you'll trade some accuracy for speed.

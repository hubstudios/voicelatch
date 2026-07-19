# VoiceLatch — Spec

Local, private voice dictation for Windows. Hold a key anywhere in Windows, speak, release —
your words are transcribed by a local Whisper model and typed into whatever app has focus,
at the cursor. A polished, complete dictation experience with original code and UI,
running 100% on-device (no account, no API key, no cloud).

## Users & portability
- Runs on any Windows 10/11 x64 PC (not just the dev machine). Delivered as a per-user
  installer (`VoiceLatch-Setup.exe`) that bundles the whisper engine, the keystroke helper, and
  the default English model — works offline immediately after install.
- Per-PC requirements: a microphone; Windows mic privacy permission for desktop apps.

## Core flows

### 1. Dictation (the product)
- **Hold mode (default):** hold Right Ctrl → recording starts instantly; a small dark pill
  overlay appears bottom-center with a live waveform; release → pill switches to "processing";
  transcribed text is injected into the focused app; pill flashes the word count and hides.
- **Toggle mode:** press hotkey once to start, again to stop (for long dictation).
- Overlay never steals focus from the target app.
- Sub-0.5s minimum recording is discarded (accidental taps). Max recording 10 minutes.
- If no speech is detected (near-silence), show "No speech detected" on the pill; inject nothing.
- Audible tick on start/stop (toggleable).
- If transcription fails, pill shows an error state; the recording is kept in history as failed.

### 2. Text injection
- **Paste mode (default):** save clipboard → put text on clipboard → synthesize Ctrl+V →
  restore previous clipboard text. Fast and reliable for long text.
- **Type mode:** synthesize the text as Unicode keystrokes (no clipboard touched). For apps
  that block paste.
- Both implemented by a tiny native helper (`injector.exe`, C#, compiled at build time,
  uses SendInput).

### 3. Transcription
- whisper.cpp (`whisper-cli.exe`, CPU) with ggml models.
- Bundled: `base.en` (default, English, fast). Downloadable in-app: tiny/base/small
  (en + multilingual) with progress bar; stored in `%APPDATA%\VoiceLatch\models`.
- Language setting: English / auto-detect / specific language (multilingual models).
- Custom dictionary "boost words" are passed as the whisper initial prompt to bias recognition
  (names, jargon).
- Post-processing: trim, whitespace collapse, optional filler-word removal (um/uh/erm),
  user-defined find→replace rules, capitalize first letter.

### 4. Dashboard (opened from tray icon)
- **Home:** stats — total words dictated, sessions, average WPM, current day-streak,
  estimated time saved vs typing (40 WPM baseline).
- **History:** searchable list of past dictations (text, app-agnostic, timestamp, duration,
  word count); copy / delete / clear all. Stored locally only.
- **Dictionary:** boost words list + find→replace rules (e.g. "vox flow" → "VoiceLatch").
- **Settings:** hotkey (press-to-capture) + hold/toggle mode; model manager (switch/download);
  language; microphone picker; injection mode; clipboard restore on/off; filler removal;
  sounds; launch at login.

### 5. System integration
- Tray icon with menu: Open Dashboard, Enable/Disable dictation, Start with Windows, Quit.
- Single instance. Closing the dashboard hides to tray; app lives in tray.
- Launch at login via Windows per-user run registration (off by default).

## Non-goals (v1)
- Cloud LLM rewriting/tone ("AI edits") — possible later as an optional API-key feature.
- macOS/Linux. Real-time streaming transcription (we transcribe on release; local models are
  fast enough for dictation-length utterances).
- Copying any commercial product's branding or assets — all code, UI, and assets are original.

## Acceptance criteria (all must pass automated verification)
1. Unit tests: WAV encoding, post-processing rules, dictionary replacement.
2. Accuracy: TTS-generated speech WAV → whisper → ≥70% word overlap with ground truth.
3. Injection: helper round-trip test — synthesized keystrokes (both modes) land verbatim in a
   real Win32 text field, including punctuation and non-ASCII characters.
4. Pipeline: WAV → transcribe → post-process → clipboard, verified end-to-end.
5. App smoke: real app boots, global hook active, tray created, overlay window valid,
   1s mic capture yields a valid 16kHz mono WAV, screenshots captured.
6. Packaged installer builds; installed app passes smoke test.

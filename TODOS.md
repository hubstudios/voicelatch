# VoiceLatch — backlog & session handoff

_Last session: 2026-07-19 (2nd). State: **v1.2.1 installed, running, FULL
selftest ALL GREEN (7/7 suites)** — repo still uncommitted (next: /gstack-ship)._

## Full selftest result (this session)
ALL GREEN: unit 39/39 · injector round-trips · accuracy 9/9 (100% overlap, both
engines, file+Buffer) · engine failover 4/4 · pipeline · in-app smoke · chained
E2E. First E2E run came back PARTIAL (paste landed the restored clipboard —
Notepad consumed Ctrl+V later than the 350 ms restore under post-suite CPU
load; pre-existing race, not the async-restore change). Fix: restoreDelayMs
default 350→800 (free now that restore is async and no longer blocks the
flash); standalone E2E re-run: **FULL, 78% acoustic overlap**._

## This session: Tier 2 — AI edits (backlog #1) implemented
Groq free tier chosen over Anthropic key (no free tier) and Gemini (free-tier
data used for training — wrong for finance dictation). One OpenAI-compatible
client (`src/main/aiedit.js`) so a local llama.cpp or any other provider plugs
in later via settings (`aiProvider: "custom"` + `aiBaseUrl`).
- Pipeline: postprocess → optional `aiedit.enhance()` → inject; strictly
  fail-open (error/timeout/junk → raw transcript injected, never lost); stale
  `gen` dropped after the await; overlay shows "AI polish…".
- Key stored DPAPI-encrypted (`aiApiKeyEnc`) via Electron safeStorage; plaintext
  only in memory. Prompt treats transcript as data (injection-resistant).
- Settings UI card (toggle OFF by default, key, model, style, Test button),
  AI badge in History, `ai` flag in history entries.
- Verified: 39/39 unit tests ×3 (8 new AI tests vs local mock server — success,
  fail-open on 500/timeout/empty/runaway, 401 mapping, prompt shape, private
  defaults) + hermetic Electron boot smoke (decrypt-fail guard exercised).
  NOT yet run: full `npm run selftest` (needs hands-off window), no live-key
  end-to-end test (needs the user's real Groq key), not committed/shipped.
- Gotcha (new): global `fetch`/undici keep-alive pools crash libuv at
  `process.exit()` on Windows (exit 127 after all tests pass) — aiedit uses
  raw `http`/`https` with `agent: false` instead. Don't reintroduce fetch.
- Also this session: **v1.2.0 built + silently installed** (user asked to use
  the AI card); autostart gap closed — `launchAtLogin` is now reconciled with
  the Windows Run key at every packaged boot (main.js boot), so the login item
  survives updates and registry cleanups, and it was turned ON for this machine
  (`electron.app.VoiceLatch` Run entry verified in HKCU). Start-at-login stays
  opt-in by default, as is standard for dictation apps.
- **v1.2.1 perf pass** (benchmarked on this i7-1255U, then installed):
  flash-attention ON with auto `-nfa` fallback (−25%/utterance, server re-tested
  stable ×3), threads cap 8→10 (all physical cores, −3%), CLI fallback got the
  missing `-bs 1` (−13% when used), WAV now posted to the server from memory
  (no temp-file write+read/AV scan; disk only for last-failed.wav on failure;
  Buffer paths covered in accuracy tests 9/9), model pre-warm fires at
  HOTKEY_DOWN (hides idle-unload rewarm inside the recording), success flash no
  longer waits the 350 ms clipboard-restore delay (restore async, guarded), AI
  edits skipped for <3-word utterances, `tiny.en-q5_1` added to the registry
  as a 2× speed pick (741 ms vs 1508 ms on the bench sentence; less accurate).
  Injector spawn measured at ~34 ms median → the deferred "resident injector"
  idea is CLOSED as not worth it (~70 ms/dictation total, both spawns).

## Where things stand
- Installed app: `%LOCALAPPDATA%\Programs\voicelatch` (v1.1.0, tray-resident, RightCtrl hold).
- Shippable installer: `VoiceLatch-Setup-1.1.0.exe` on the Desktop and in `dist/` (150 MB,
  fully offline, unsigned → SmartScreen "More info → Run anyway" on new PCs).
- Repo: 4 commits on `master`, clean tree. Full verification: `npm run selftest`
  (needs ~3 min hands-off — it injects keystrokes and plays audio; it stops a running
  production VoiceLatch first and that's intentional).
- User data/logs: `%APPDATA%\VoiceLatch` (settings auto-migrated to `base.en-q5_1`).

## Verified this session (evidence in selftest-artifacts/ + git log)
31 unit tests; injector round-trips; accuracy 100% both engines; failover drills;
speech→keys pipeline; in-app smoke 13/13; chained E2E FULL (twice); packaged clean-PC
12/12 (v1.0.0 and v1.1.0); silent upgrade 1.0→1.1 with automatic model migration;
one real dictation driven through the installed production app; plus the user's own
real dictations (55 words @ 143 WPM into VS Code).

## Backlog (in rough priority order)
1. ~~Tier 2 — optional "AI edits" mode~~ **DONE this session** (see above).
   Follow-ups: run full selftest + user tests with real Groq key → commit →
   `/gstack-ship` (v1.2.0); later: local llama.cpp preset in the UI (offline
   rewrites), keep raw+edited text pairs in history.
2. Combo hotkeys (e.g. Ctrl+Win) — uiohook multi-key state tracking in hotkeys.js.
3. Per-app injection profiles (fginfo proc → forced type-mode etc.).
4. Overlay position options (bottom-center is currently fixed; anchor logic in
   windows.js `overlayPosition`).
5. Mic pre-warm toggle (zero lead-in loss; keeps mic indicator on — privacy tradeoff,
   default off).
6. Proactive mic-permission check at dashboard open (permissions.query, no mic light) —
   accepted in the design review, never implemented; reactive error path works.
7. Deferred from code review (logged, low risk): async retry in store writes (currently
   bounded sync busy-wait), shared download helper (setup.js/models.js duplication),
   WAV buffer straight to server (skip disk round-trip), test-fixture consolidation.
8. Housekeeping: delete `VoiceLatch-Setup-1.0.0.exe` from Desktop (superseded; a safety
   hook blocked agent deletion).

## Gotchas for the next session (hard-won)
- Focus-sensitive tests lose races against a human typing — the suite idle-gates and
  retries, but a fully hands-off window is still the reliable way to run it.
- Never run the dev suite with the installed app up (shared %APPDATA% single-instance
  lock) — orchestrator now kills it; relaunch the installed app afterwards.
- whisper-server needs app-local MSVC DLLs + cwd=binDir + existing --public.
  (`-nfa` is NO LONGER forced: flash-attention re-tested stable 2026-07-19 and
  is ~25% faster — transcriber auto-retries with `-nfa` if a server dies.).
- PowerShell doesn't wait for GUI-subsystem exes (electron/VoiceLatch) — use Node spawn
  or `Start-Process -Wait`, and never trust `$LASTEXITCODE` from a bare `&` call.
- Zip extraction via Node deadlocks on this machine — tar.exe only (setup.js does).

# Third-party components

VoiceLatch itself is MIT-licensed (see LICENSE). It builds on and redistributes
the following third-party components; each remains under its own license.

| Component | Use | License |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Speech recognition engine (`whisper-cli.exe`, `whisper-server.exe`, ggml DLLs) | MIT |
| [OpenAI Whisper models](https://huggingface.co/ggerganov/whisper.cpp) | Bundled/downloadable ggml speech models | MIT |
| [Electron](https://www.electronjs.org/) | Application shell and UI runtime | MIT |
| [uiohook-napi](https://github.com/SnosMe/uiohook-napi) | Node bindings for the global keyboard hook | MIT |
| [libuiohook](https://github.com/kwhat/libuiohook) | Native global input hook, bundled inside uiohook-napi | LGPL-3.0 |
| [NSIS](https://nsis.sourceforge.io/) | Installer stub produced by electron-builder | zlib/libpng |
| Microsoft Visual C++ runtime DLLs | Redistributed beside the whisper binaries per Microsoft's redistribution terms | Microsoft Software License |

libuiohook is LGPL-3.0: it is used unmodified through uiohook-napi's prebuilt
binding, and the complete source of this application is publicly available,
satisfying the LGPL's source-availability and relink requirements.

The `injector.exe` helper is original code in this repository (`native/injector.cs`, MIT).

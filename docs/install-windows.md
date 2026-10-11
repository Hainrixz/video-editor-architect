# Install on Windows

[Español](instalar-windows.es.md) · [macOS](install-macos.md)

Checked on 2026-10-11. Sources in [fuentes-investigacion.md](fuentes-investigacion.md). Commands are for **PowerShell**. Open a **new** terminal after each install so the PATH updates.

## Before you start

- **Windows 10 1809+ or Windows 11, x64.** Remotion renders on Windows x64 only; Windows on ARM is not supported by Remotion.
- About 5 GB free for the speech models, plus room for your videos.
- `winget` comes with current Windows (App Installer). Chocolatey and Scoop work too; the winget IDs are below.

When you finish, run `npx tsx herramientas/doctor.ts` in the project. It checks everything and tells you what is missing.

## Two ways to run it

**A. Native Windows (simplest).** Everything below. Important: **Claude Code's sandbox does not run on native Windows.** Claude Code's docs say so directly: "On native Windows, Claude Code runs commands unsandboxed." The project's rules still apply (no keys, no spending without your yes, originals untouched), but nothing at the OS level enforces them. Keep the `deny` and `ask` permissions in `.claude/settings.json` and read what the agent proposes before saying yes.

**B. WSL2 (recommended if you want the sandbox).** The sandbox runs on macOS, Linux and WSL2 (not WSL1). Inside WSL2 you follow Linux steps: install Claude Code with `curl -fsSL https://claude.ai/install.sh | bash`, the sandbox needs `bubblewrap` and `socat`, Remotion needs glibc 2.35+ and its Linux packages, and whisper.cpp has Ubuntu x64 builds in its releases. Keep the project inside the Linux filesystem (for example `~/my-editor`), not under `/mnt/c`. A full WSL2 guide is **not written yet**; this page covers native Windows.

## 1. Git for Windows

```powershell
winget install --id Git.Git -e
```

Claude Code uses Git Bash for its Bash tool; without Git for Windows it falls back to PowerShell. The project's `public/` folder uses **symlinks**: before cloning, turn on Windows **Developer Mode** (Settings → System → For developers) and run:

```powershell
git config --global core.symlinks true
```

If you already cloned, clone again after this.

## 2. Node.js 24

```powershell
winget install --id OpenJS.NodeJS.LTS -e
node -v
```

On 2026-10-11 the winget LTS package was Node 24 (24.20.0). The project needs 24 or more. When the LTS line moves to Node 26, `winget` will install 26: it meets the requirement but this template was **not tested** on it. To stay on 24, use `--version 24.20.0` (or a newer 24.x) or a version manager such as fnm.

## 3. ffmpeg and ffprobe

```powershell
winget install --id Gyan.FFmpeg.Essentials -e
ffmpeg -version
ffprobe -version
```

The gyan.dev builds include `ffmpeg`, `ffprobe` and `ffplay` (GPLv3). Full build: `Gyan.FFmpeg`. Chocolatey: `choco install ffmpeg`.

## 4. whisper.cpp

There is no winget package. Download the official Windows build from the GitHub releases of `ggml-org/whisper.cpp`:

- Since `v1.9.3`, the tagged releases (for example `v1.9.5`) have no files attached. The Windows zips are on the build releases named `b<number>` (on 2026-10-11, the newest was `b5454`).
- CPU: `whisper-bin-x64.zip`.
- NVIDIA GPU: `whisper-bin-win-cuda-12.4.0-x64.zip` (or the 11.8.0 one for older drivers). These names change between builds; older builds called them `whisper-cublas-12.4.0-bin-x64.zip`.

Unzip it to a folder such as `C:\Tools\whisper`. The `Release\` folder contains **`whisper-cli.exe`** and **`whisper-vad-speech-segments.exe`** (both checked in `b5454`), plus the `ggml*.dll` files they need. Keep them together and add that folder to your PATH, or point the tools at it (see step 5).

whisper.cpp is MIT.

## 5. The speech models

Official Hugging Face files:

- large-v3 (about 3.1 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
- Optional, faster large-v3-turbo (about 1.6 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
- Silero VAD v5.1.2 (under 1 MB): https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

```powershell
mkdir $HOME\whisper-models
cd $HOME\whisper-models
curl.exe -L -O https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
curl.exe -L -O https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

Use `curl.exe`, not `curl` (in PowerShell, `curl` can be an alias of `Invoke-WebRequest`). Then tell the tools where things are: `doctor.ts` shows the path or variable it expects (at the time of writing `EDITOR_WHISPER_MODELO`, `EDITOR_VAD_MODELO` and `EDITOR_VAD_CLI`; or `EDITOR_MODELOS` for one folder with both models, default `~/.cache/video-editor/modelos`). To set one for your user:

```powershell
setx EDITOR_WHISPER_MODELO "$HOME\whisper-models\ggml-large-v3.bin"
```

## 6. uv and Python 3.12

```powershell
winget install --id astral-sh.uv -e
uv python install 3.12
```

Alternative installer: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`.

In the project, create the environment with `uv venv .venv --python 3.12` and install the pinned packages with `uv pip install --python .venv\Scripts\python.exe -r herramientas/py/requirements.txt` (`doctor.ts` prints the same line). On Windows the Python engine is the only one (`EDITOR_VISION=python` is implied).

## 7. Text and face recognition without Apple Vision

On macOS the project uses Apple Vision (Swift) for OCR and face tracking. On Windows there is no Apple Vision and no Swift toolchain for it, so text and face recognition run in **Python inside the project's `.venv`**:

- **RapidOCR** for OCR (Apache-2.0). It needs an inference engine installed next to it: `rapidocr` plus `onnxruntime`.
- **MediaPipe** for face detection (Apache 2.0). Version 1.1.0 has `win_amd64` wheels.

The pinned install line comes from `doctor.ts`. Results can differ slightly from Apple Vision; if a stage is not available on Windows yet, `doctor.ts` and the agent say so.

## 8. yt-dlp

Only needed to download reels (yours or the reference creators you name).

```powershell
winget install --source winget --id yt-dlp.yt-dlp
```

## 9. Chrome and Playwright

- Remotion downloads its own Chrome Headless Shell (Windows x64) on the first render. To fetch it early: `npx remotion browser ensure`.
- The screen-demo recorder uses Google Chrome and Playwright's Chromium:

```powershell
winget install --id Google.Chrome -e
npx playwright install chromium
```

Playwright stores its browsers in `%USERPROFILE%\AppData\Local\ms-playwright`.

## 10. Claude Code

```powershell
irm https://claude.ai/install.ps1 | iex
```

Or `winget install Anthropic.ClaudeCode` (winget installs don't auto-update: `winget upgrade Anthropic.ClaudeCode`). No admin rights needed.

## 11. Project and plugins

```powershell
npm ci
npx tsx herramientas/doctor.ts
claude
```

Accept the folder trust dialog, then install the recommended plugins: [skills.md](skills.md). Note: HyperFrames and BRAG have no official Windows support statement (not verified), and Motion Architect's installer is macOS and Linux only.

## What is different from macOS

- No sandbox on native Windows (use WSL2 if you want it).
- No Apple Vision: OCR and face use RapidOCR and MediaPipe in Python.
- The native window recorder (`herramientas/grabador/ventana.ts`) relies on macOS screen capture; on Windows, record demos with the web recorder (Chrome + Playwright). Whether `ventana.ts` runs on Windows is not verified.
- Paths use `\`; the tools take care of it, but write paths in quotes if they have spaces.

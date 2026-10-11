# Install on macOS

[Español](instalar-macos.es.md) · [Windows](install-windows.md)

Checked on 2026-10-11. Versions in parentheses are what Homebrew offered that day. Sources in [fuentes-investigacion.md](fuentes-investigacion.md).

## Before you start

- **macOS 15 (Sequoia) or newer.** Remotion does not support older versions.
- Apple Silicon or Intel both work.
- About 5 GB free for the speech models, plus room for your videos.

When you finish, run `npx tsx herramientas/doctor.ts` in the project. It checks everything below and tells you exactly what is missing.

## 1. Xcode Command Line Tools

Face tracking, OCR and some style measurements use Apple Vision through small Swift programs (`herramientas/vision/`). Compiling them needs `swiftc`:

```bash
xcode-select --install
```

Then compile them with the scripts in `herramientas/vision/` (`compilar*.sh`). The binaries are ignored by git.

## 2. Homebrew

If you don't have it, install it from https://brew.sh. Everything below uses it.

## 3. Node.js 24

The project requires Node 24 or newer (24.21.0 is the current LTS).

```bash
brew install node@24
```

`node@24` is keg-only, so add it to your PATH (Apple Silicon path shown):

```bash
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v
```

A version manager (nvm, fnm, Volta) works too, as long as `node -v` says 24 or more.

## 4. ffmpeg and ffprobe

```bash
brew install ffmpeg
```

(9.0.2). It installs both `ffmpeg` and `ffprobe`. Remotion carries its own small FFmpeg for rendering, but the rest of the tools use the system one.

## 5. whisper.cpp and the models

```bash
brew install whisper.cpp
```

(1.9.5; the old name `whisper-cpp` still works). It installs `whisper-cli` and `whisper-vad-speech-segments`, both needed.

Download the models from the official Hugging Face repos:

- Speech model large-v3 (about 3.1 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
- Optional, faster large-v3-turbo (about 1.6 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
- Silero VAD v5.1.2 (under 1 MB): https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

For example:

```bash
mkdir -p ~/whisper-models && cd ~/whisper-models
curl -L -O https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
curl -L -O https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

Then tell the tools where they are. `doctor.ts` shows the path or environment variable it expects (at the time of writing, `EDITOR_WHISPER_MODELO` and `EDITOR_VAD_MODELO`, plus `EDITOR_VAD_CLI` if `whisper-vad-speech-segments` is not next to `whisper-cli`). If you put both models in one folder, `EDITOR_MODELOS=<folder>` is enough (default `~/.cache/video-editor/modelos`).

whisper.cpp is MIT. The transcription runs on your Mac; nothing is uploaded.

## 6. uv and Python 3.12

```bash
brew install uv
uv python install 3.12
```

(uv 0.13.0). Alternative: `curl -LsSf https://astral.sh/uv/install.sh | sh`. In the project, create the environment with `uv venv .venv --python 3.12`; then install the pinned Python packages with `uv pip install --python .venv/bin/python -r herramientas/py/requirements.txt` (`doctor.ts` prints the same line). Apple Vision is used by default when its binaries are compiled; `EDITOR_VISION=python` forces the Python engine (RapidOCR + MediaPipe) and `EDITOR_VISION=vision` forces Apple Vision.

## 7. yt-dlp

Only needed to download reels (yours or the reference creators you name).

```bash
brew install yt-dlp
```

## 8. Chrome and Playwright

- Remotion downloads its own Chrome Headless Shell on the first render; nothing to do. You can fetch it early with `npx remotion browser ensure`.
- The screen-demo recorder uses Google Chrome and Playwright's Chromium:

```bash
brew install --cask google-chrome
npx playwright install chromium
```

## 9. Git

macOS includes Git with the Command Line Tools. `brew install git` gives you a newer one (2.56.0).

## 10. Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Or `brew install --cask claude-code` (Homebrew installs don't auto-update; run `brew upgrade claude-code`). Claude Code needs macOS 13 or newer, but Remotion needs 15.

## 11. Screen permissions

The screen recorder and window capture need **Screen Recording** permission for your terminal (System Settings → Privacy & Security). macOS asks the first time.

## 12. The sandbox

On macOS the project runs every Bash command inside Claude Code's sandbox (configured in `.claude/settings.json`). Chrome, the GPU and Apple Vision don't work inside it, so render, transcription, face and QA commands are listed in `excludedCommands` and must run alone in their Bash call. If something fails because of the sandbox, the agent tells you which restriction it hit; changing it is your decision.

## 13. Project and plugins

```bash
npm ci
npx tsx herramientas/doctor.ts
claude
```

Accept the folder trust dialog, then install the recommended plugins: [skills.md](skills.md).

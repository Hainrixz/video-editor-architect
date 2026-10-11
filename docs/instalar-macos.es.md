# Instalar en macOS

[English](install-macos.md) · [Windows](instalar-windows.es.md)

Revisado el 2026-10-11. Las versiones entre paréntesis son las que tenía Homebrew ese día. Fuentes en [fuentes-investigacion.md](fuentes-investigacion.md).

## Antes de empezar

- **macOS 15 (Sequoia) o más nuevo.** Remotion no soporta versiones anteriores.
- Sirve igual con Apple Silicon o Intel.
- Unos 5 GB libres para los modelos de voz, más el espacio de tus videos.

Al terminar, corre `npx tsx herramientas/doctor.ts` en el proyecto. Revisa todo lo de abajo y te dice qué falta.

## La vía rápida: `npm run instalar`

Si ya tienes Node 24 y el proyecto clonado con `npm ci` hecho, un comando instala lo demás:

```bash
npm run instalar          # muestra el plan: qué falta, el comando de cada cosa y cuánto baja
npm run instalar -- --si  # lo instala, paso a paso
```

Solo instala lo que falta: ffmpeg, uv, yt-dlp, whisper.cpp y Chrome con Homebrew; el `.venv` de Python; el modelo large-v3 de whisper (**unos 3.1 GB**, la descarga se retoma si se corta) y el VAD silero; los paquetes de OCR y cara; el Chromium de Playwright; las fuentes OFL; y compila Apple Vision si hay `swiftc`. Cada paso se revisa al terminar, y al final dice "listo X de Y (Z omitidos)". `--solo uv,venv` lo limita a algunas piezas.

Nunca usa `sudo` y nunca toca tus llaves. Lo que pide tu contraseña te lo imprime para que lo corras tú: Homebrew (si no lo tienes) y `xcode-select --install`. Luego corre `npx tsx herramientas/doctor.ts` para confirmar.

Los pasos manuales de abajo hacen lo mismo, uno por uno.

## 1. Xcode Command Line Tools

El seguimiento de cara, el OCR y algunas mediciones de estilo usan Apple Vision con programas chicos en Swift (`herramientas/vision/`). Para compilarlos necesitas `swiftc`:

```bash
xcode-select --install
```

Luego compílalos con los scripts de `herramientas/vision/` (`compilar*.sh`). Los binarios no se suben a git.

## 2. Homebrew

Si no lo tienes, instálalo desde https://brew.sh. Todo lo de abajo lo usa.

## 3. Node.js 24

El proyecto pide Node 24 o más (la LTS actual es 24.21.0).

```bash
brew install node@24
```

`node@24` no se enlaza solo, así que agrégalo a tu PATH (ruta de Apple Silicon):

```bash
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v
```

También sirve un gestor de versiones (nvm, fnm, Volta), mientras `node -v` diga 24 o más.

## 4. ffmpeg y ffprobe

```bash
brew install ffmpeg
```

(9.0.2). Instala `ffmpeg` y `ffprobe`. Remotion trae su propio FFmpeg chico para renderizar, pero las demás herramientas usan el del sistema.

## 5. whisper.cpp y los modelos

```bash
brew install whisper.cpp
```

(1.9.5; el nombre viejo `whisper-cpp` también funciona). Instala `whisper-cli` y `whisper-vad-speech-segments`; necesitas los dos.

Baja los modelos de los repos oficiales en Hugging Face:

- Modelo de voz large-v3 (unos 3.1 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
- Opcional, más rápido, large-v3-turbo (unos 1.6 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
- VAD Silero v5.1.2 (menos de 1 MB): https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

Por ejemplo:

```bash
mkdir -p ~/whisper-models && cd ~/whisper-models
curl -L -O https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
curl -L -O https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

Luego dile a las herramientas dónde quedaron. `doctor.ts` te muestra la ruta o la variable de entorno que espera (hoy son `EDITOR_WHISPER_MODELO` y `EDITOR_VAD_MODELO`, y `EDITOR_VAD_CLI` si `whisper-vad-speech-segments` no está junto a `whisper-cli`). Si pones los dos modelos en una carpeta, basta con `EDITOR_MODELOS=<carpeta>` (por defecto `~/.cache/video-editor/modelos`).

whisper.cpp es MIT. La transcripción corre en tu Mac; no se sube nada.

## 6. uv y Python 3.12

```bash
brew install uv
uv python install 3.12
```

(uv 0.13.0). Otra opción: `curl -LsSf https://astral.sh/uv/install.sh | sh`. En el proyecto, crea el entorno con `uv venv .venv --python 3.12`; luego instala los paquetes de Python con sus versiones fijas: `uv pip install --python .venv/bin/python -r herramientas/py/requirements.txt` (`doctor.ts` te da la misma línea). Si sus binarios están compilados se usa Apple Vision; `EDITOR_VISION=python` fuerza el motor de Python (RapidOCR + MediaPipe) y `EDITOR_VISION=vision` fuerza Apple Vision.

## 7. yt-dlp

Solo hace falta para bajar reels (los tuyos o los de los creadores que nombres como referencia).

```bash
brew install yt-dlp
```

## 8. Chrome y Playwright

- Remotion baja su propio Chrome Headless Shell en el primer render; no tienes que hacer nada. Si quieres, bájalo antes con `npx remotion browser ensure`.
- El grabador de demos usa Google Chrome y el Chromium de Playwright:

```bash
brew install --cask google-chrome
npx playwright install chromium
```

## 9. Git

macOS trae Git con las Command Line Tools. Con `brew install git` tienes uno más nuevo (2.56.0).

## 10. Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

O `brew install --cask claude-code` (con Homebrew no se actualiza solo; corre `brew upgrade claude-code`). Claude Code pide macOS 13 o más, pero Remotion pide 15.

## 11. Permisos de pantalla

El grabador de pantalla y la captura de ventanas necesitan el permiso de **Grabación de pantalla** para tu terminal (Ajustes del Sistema → Privacidad y seguridad). macOS te lo pide la primera vez.

## 12. El sandbox

En macOS el proyecto corre cada comando de Bash dentro del sandbox de Claude Code (configurado en `.claude/settings.json`). Chrome, la GPU y Apple Vision no funcionan ahí adentro, así que los comandos de render, transcripción, cara y QA están en `excludedCommands` y van solos en su llamada de Bash. Si algo falla por el sandbox, el agente te dice qué restricción tocó; cambiarlo es decisión tuya.

## 13. Proyecto y plugins

```bash
npm ci
npx tsx herramientas/doctor.ts
claude
```

Acepta el aviso de confianza de la carpeta y luego instala los plugins recomendados: [habilidades.es.md](habilidades.es.md).

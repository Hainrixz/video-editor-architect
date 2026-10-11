# Instalar en Windows

[English](install-windows.md) · [macOS](instalar-macos.es.md)

Revisado el 2026-10-11. Fuentes en [fuentes-investigacion.md](fuentes-investigacion.md). Los comandos son para **PowerShell**. Abre una terminal **nueva** después de cada instalación para que se actualice el PATH.

## Antes de empezar

- **Windows 10 1809+ o Windows 11, x64.** Remotion solo renderiza en Windows x64; Windows en ARM no tiene soporte de Remotion.
- Unos 5 GB libres para los modelos de voz, más el espacio de tus videos.
- `winget` ya viene en Windows (Instalador de aplicaciones). Chocolatey y Scoop también sirven; abajo van los IDs de winget.

Al terminar, corre `npx tsx herramientas/doctor.ts` en el proyecto. Revisa todo y te dice qué falta.

## La vía rápida: `npm run instalar`

Después de los pasos 1 y 2 (Git y Node 24), clona el proyecto y corre `npm ci` dentro. Luego un comando instala lo demás:

```powershell
npm run instalar          # muestra el plan: qué falta, el comando de cada cosa y cuánto baja
npm run instalar -- --si  # lo instala, paso a paso
```

Solo instala lo que falta: ffmpeg (`Gyan.FFmpeg`), uv, yt-dlp y Chrome con `winget` (acepta por ti los acuerdos del origen y del paquete); whisper.cpp del zip oficial de las releases de `ggml-org/whisper.cpp`, descomprimido en `%USERPROFILE%\.cache\video-editor\whisper`, con `EDITOR_WHISPER_CLI` y `EDITOR_VAD_CLI` fijadas para tu usuario (`setx`, sin administrador); el `.venv` de Python con los paquetes de OCR y cara; el modelo large-v3 de whisper (**unos 3.1 GB**, la descarga se retoma si se corta) y el VAD silero; el Chromium de Playwright; y las fuentes OFL. Cada paso se revisa al terminar, y al final dice "listo X de Y (Z omitidos)". `--solo uv,venv` lo limita a algunas piezas.

Nunca pide permisos de administrador por su cuenta y nunca toca tus llaves. Node solo se avisa (es lo que corre el instalador). Al terminar, **abre una terminal nueva** (y reinicia Claude Code) para que se vean el PATH y las variables nuevas, y corre `npx tsx herramientas/doctor.ts`. Recuerda: en Windows nativo Claude Code no tiene sandbox, así que lee el plan antes de decir que sí.

Los pasos manuales de abajo hacen lo mismo, uno por uno.

## Dos formas de correrlo

**A. Windows nativo (lo más simple).** Todo lo de esta página. Importante: **el sandbox de Claude Code no corre en Windows nativo.** La documentación de Claude Code lo dice tal cual: en Windows nativo, Claude Code corre los comandos sin sandbox. Las reglas del proyecto siguen (nada de llaves, nada de gastos sin tu sí, los originales no se tocan), pero el sistema operativo no las hace cumplir. Deja los permisos `deny` y `ask` de `.claude/settings.json` y lee lo que te propone el agente antes de decir que sí.

**B. WSL2 (lo recomendado si quieres sandbox).** El sandbox corre en macOS, Linux y WSL2 (no en WSL1). Dentro de WSL2 sigues pasos de Linux: instalas Claude Code con `curl -fsSL https://claude.ai/install.sh | bash`, el sandbox pide `bubblewrap` y `socat`, Remotion pide glibc 2.35+ y sus paquetes de Linux, y whisper.cpp tiene builds para Ubuntu x64 en sus releases. Deja el proyecto dentro del sistema de archivos de Linux (por ejemplo `~/mi-editor`), no en `/mnt/c`. La guía completa de WSL2 **todavía no está escrita**; esta página cubre Windows nativo.

## 1. Git para Windows

```powershell
winget install --id Git.Git -e
```

Claude Code usa Git Bash para su herramienta de Bash; sin Git para Windows usa PowerShell. La carpeta `public/` del proyecto usa **symlinks**: antes de clonar, prende el **Modo de desarrollador** de Windows (Configuración → Sistema → Para programadores) y corre:

```powershell
git config --global core.symlinks true
```

Si ya habías clonado, vuelve a clonar después de esto.

## 2. Node.js 24

```powershell
winget install --id OpenJS.NodeJS.LTS -e
node -v
```

El 2026-10-11 el paquete LTS de winget era Node 24 (24.20.0). El proyecto pide 24 o más. Cuando la LTS pase a Node 26, `winget` te va a instalar 26: cumple el requisito, pero la plantilla **no se probó** con esa versión. Para quedarte en 24, usa `--version 24.20.0` (o una 24.x más nueva) o un gestor de versiones como fnm.

## 3. ffmpeg y ffprobe

```powershell
winget install --id Gyan.FFmpeg.Essentials -e
ffmpeg -version
ffprobe -version
```

Las builds de gyan.dev traen `ffmpeg`, `ffprobe` y `ffplay` (GPLv3). La build completa es `Gyan.FFmpeg`. Con Chocolatey: `choco install ffmpeg`.

## 4. whisper.cpp

No hay paquete en winget. Baja la build oficial para Windows de los releases de GitHub de `ggml-org/whisper.cpp`:

- Desde `v1.9.3`, los releases con etiqueta (por ejemplo `v1.9.5`) no traen archivos. Los zips de Windows están en los releases de build que se llaman `b<número>` (el 2026-10-11 el más nuevo era `b5454`).
- CPU: `whisper-bin-x64.zip`.
- GPU NVIDIA: `whisper-bin-win-cuda-12.4.0-x64.zip` (o el de 11.8.0 para drivers viejos). Los nombres cambian entre builds; en builds anteriores se llamaban `whisper-cublas-12.4.0-bin-x64.zip`.

Descomprímelo en una carpeta como `C:\Tools\whisper`. La carpeta `Release\` trae **`whisper-cli.exe`** y **`whisper-vad-speech-segments.exe`** (los dos revisados en `b5454`), más los `ggml*.dll` que necesitan. Déjalos juntos y agrega esa carpeta al PATH, o dile a las herramientas dónde está (paso 5).

whisper.cpp es MIT.

## 5. Los modelos de voz

Archivos oficiales en Hugging Face:

- large-v3 (unos 3.1 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
- Opcional, más rápido, large-v3-turbo (unos 1.6 GB): https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
- VAD Silero v5.1.2 (menos de 1 MB): https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

```powershell
mkdir $HOME\whisper-models
cd $HOME\whisper-models
curl.exe -L -O https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
curl.exe -L -O https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

Usa `curl.exe`, no `curl` (en PowerShell, `curl` puede ser un alias de `Invoke-WebRequest`). Luego dile a las herramientas dónde quedó todo: `doctor.ts` te muestra la ruta o la variable que espera (hoy son `EDITOR_WHISPER_MODELO`, `EDITOR_VAD_MODELO` y `EDITOR_VAD_CLI`; o `EDITOR_MODELOS` para una carpeta con los dos modelos, por defecto `~/.cache/video-editor/modelos`). Para fijar una en tu usuario:

```powershell
setx EDITOR_WHISPER_MODELO "$HOME\whisper-models\ggml-large-v3.bin"
```

## 6. uv y Python 3.12

```powershell
winget install --id astral-sh.uv -e
uv python install 3.12
```

Otro instalador: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`.

En el proyecto, crea el entorno con `uv venv .venv --python 3.12` e instala los paquetes con sus versiones fijas: `uv pip install --python .venv\Scripts\python.exe -r herramientas/py/requirements.txt` (`doctor.ts` te da la misma línea). En Windows el único motor es el de Python (`EDITOR_VISION=python` va implícito).

## 7. Reconocer texto y cara sin Apple Vision

En macOS el proyecto usa Apple Vision (Swift) para el OCR y el seguimiento de cara. En Windows no hay Apple Vision ni Swift para eso, así que el texto y la cara se reconocen con **Python dentro del `.venv` del proyecto**:

- **RapidOCR** para el OCR (Apache-2.0). Necesita un motor de inferencia junto a él: `rapidocr` más `onnxruntime`.
- **MediaPipe** para detectar la cara (Apache 2.0). La versión 1.1.0 trae wheels para `win_amd64`.

La línea de instalación con versiones fijas sale de `doctor.ts`. Los resultados pueden variar un poco respecto a Apple Vision; si una etapa todavía no está lista en Windows, `doctor.ts` y el agente te lo dicen.

## 8. yt-dlp

Solo hace falta para bajar reels (los tuyos o los de los creadores que nombres como referencia).

```powershell
winget install --source winget --id yt-dlp.yt-dlp
```

## 9. Chrome y Playwright

- Remotion baja su propio Chrome Headless Shell (Windows x64) en el primer render. Si quieres bajarlo antes: `npx remotion browser ensure`.
- El grabador de demos usa Google Chrome y el Chromium de Playwright:

```powershell
winget install --id Google.Chrome -e
npx playwright install chromium
```

Playwright guarda sus navegadores en `%USERPROFILE%\AppData\Local\ms-playwright`.

## 10. Claude Code

```powershell
irm https://claude.ai/install.ps1 | iex
```

O `winget install Anthropic.ClaudeCode` (con winget no se actualiza solo: `winget upgrade Anthropic.ClaudeCode`). No necesitas permisos de administrador.

## 11. Proyecto y plugins

```powershell
npm ci
npx tsx herramientas/doctor.ts
claude
```

Acepta el aviso de confianza de la carpeta y luego instala los plugins recomendados: [habilidades.es.md](habilidades.es.md). Ojo: HyperFrames y BRAG no dicen oficialmente si soportan Windows (sin verificar), y el instalador de Motion Architect solo es para macOS y Linux.

## Qué cambia respecto a macOS

- No hay sandbox en Windows nativo (usa WSL2 si lo quieres).
- No hay Apple Vision: el OCR y la cara van con RapidOCR y MediaPipe en Python.
- El grabador de ventanas nativo (`herramientas/grabador/ventana.ts`) usa la captura de pantalla de macOS; en Windows graba las demos con el grabador web (Chrome + Playwright). Si `ventana.ts` corre en Windows está sin verificar.
- Las rutas usan `\`; las herramientas lo resuelven, pero pon entre comillas las rutas que tengan espacios.

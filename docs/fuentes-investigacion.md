# Fuentes de la investigación / Research sources

Todo consultado el 2026-10-11. Una línea por fuente con lo que dijo. / Everything checked on 2026-10-11, one line per source.

Ninguna página consultada intentó dar instrucciones al agente; no hubo nada que ignorar. / No page tried to give the agent instructions; nothing had to be ignored.

## Remotion

- https://registry.npmjs.org/remotion/latest — versión estable 4.0.534; licencia "SEE LICENSE IN LICENSE.md".
- https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md — gratis para personas, empresas de hasta 3 empleados, sin fines de lucro y evaluación; el resto necesita Company License. "Copyright © 2026 Remotion".
- https://www.remotion.dev/docs/license/pricing — Company License para equipos de 4+; Creators 25 USD/mes por asiento; Automators 0.01 USD por render, mínimo 100 USD/mes; Enterprise desde 500 USD/mes.
- https://www.remotion.pro/license — mismos precios (Creators, Automators, mínimo combinado 100 USD/mes).
- https://www.remotion.dev/docs/license/faq — define "automatización" (código que llama a `renderMedia()`, `npx remotion render`, `<Player>`, etc.); con licencia gratuita no se paga por render; una empresa de 1 a 3 personas puede usar la licencia gratuita.
- https://www.remotion.dev/docs/license — índice de licencia y términos (sin detalle propio); pie "Remotion AG".
- https://www.remotion.dev/docs/ — requisitos: Node 16+ o Bun 1.0.3; macOS 15 (Sequoia) o más; Linux con glibc 2.35+; Alpine y NixOS sin soporte.
- https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell — Remotion instala Chrome Headless Shell solo en `node_modules/.remotion/chrome-headless-shell/[platform]/`; plataformas macOS x64/arm64, Windows x64, Linux x64/arm64; `npx remotion browser ensure`.
- https://www.remotion.dev/docs/cli/ffmpeg — FFmpeg incluido, línea 7.1, solo códecs H.264, H.265, VP8, VP9, ProRes; `npx remotion ffmpeg`.
- https://www.remotion.dev/docs/4-0-migration (vía búsqueda web) — FFmpeg integrado en `@remotion/renderer` (dice línea 6.0); plataformas: Windows (solo x64), macOS, Linux.
- https://www.remotion.dev/docs/ai/skills — skills oficiales: `npx skills add remotion-dev/skills` o `bun create video`; lista de las 12 skills y qué cubre cada una.
- https://www.remotion.dev/docs/ai/claude-code — también `npx remotion skills add` dentro de un proyecto.
- https://github.com/remotion-dev/skills y https://api.github.com/repos/remotion-dev/skills — repo público "Agent Skills"; GitHub no reporta licencia; sin `.claude-plugin`; último commit 32b241b97f4e0e4ab61fe9a41b05e6e64503f8c5 (2026-10-07).
- https://raw.githubusercontent.com/remotion-dev/remotion/main/packages/skills/README.md — instalación con `npx skills add remotion-dev/skills`; no menciona licencia.
- Local: `~/.claude/skills/remotion-*/SKILL.md` (versión 4.0.533) y `~/.agents/.skill-lock.json` (fuente `remotion-dev/skills`).
- No encontradas (404): https://www.remotion.dev/docs/linux-dependencies, https://www.remotion.dev/docs/ffmpeg, https://www.remotion.dev/docs/system-requirements, https://www.remotion.dev/docs/license-faq.

## Claude Code

- https://code.claude.com/docs/en/sandboxing — "The sandbox runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed."; WSL1 no sirve; en Linux/WSL2 usa bubblewrap y socat.
- https://code.claude.com/docs/en/settings — `extraKnownMarketplaces` solo aplica cuando aceptas la confianza de la carpeta; `deny` y `ask` aplican de inmediato.
- https://code.claude.com/docs/en/settings-reference.md — formato de `enabledPlugins` (`plugin@marketplace`: booleano) y `extraKnownMarketplaces` (`source` + `autoUpdate`); tipos de fuente `github`, `git`, `url`, `file`, `directory`, `settings`; un plugin externo habilitado en el proyecto no se instala solo.
- https://code.claude.com/docs/en/plugins/marketplace-reference.md — las fuentes de plugin `github`, `url` y `git-subdir` aceptan `ref` y `sha` (40 caracteres); las fuentes de marketplace `github`/`git` aceptan `ref` pero no `sha`; nombres reservados como `claude-plugins-official`.
- https://code.claude.com/docs/en/plugins/org.md — "Require plugins per repository": cada persona corre `claude plugin install <name>@<marketplace> --scope project`; `claude-plugins-official` no necesita entrada en `extraKnownMarketplaces`.
- https://code.claude.com/docs/en/plugin-marketplaces — cómo se crea y valida un marketplace; `claude plugin validate`.
- https://code.claude.com/docs/en/setup.md — requisitos: macOS 13+, Windows 10 1809+; instaladores `install.sh`, `install.ps1`, Homebrew `claude-code`, WinGet `Anthropic.ClaudeCode`; Git para Windows recomendado para la herramienta Bash; tabla: sandbox no soportado en Windows nativo ni WSL1, sí en WSL2.

## BRAG y HyperFrames

- Local: `~/.claude/plugins/marketplaces/brag` (README, `skills/brag/SKILL.md`, `skills/brag-slim/SKILL.md`, `.claude-plugin/*.json`) — plugin `brag` 0.4.0, MIT, autora Shunit Haviv Hakimi; requisitos Node 22+, FFmpeg, CLI de HyperFrames; `/brag-slim` toma el control en Opus 5.5; nota de symlinks en Windows.
- https://api.github.com/repos/latent-spaces/brag/commits/main — último commit 8531ccb9f471ef5099abf930079e47b55c55bb21 (2026-10-09).
- https://raw.githubusercontent.com/latent-spaces/brag/main/LICENSE — MIT, Copyright (c) 2026 Shunit Haviv Hakimi.
- https://hyperframes.heygen.com/ — "The video editor built for agents"; `npx skills add heygen-com/hyperframes`; apps de escritorio para macOS y Linux.
- https://api.github.com/repos/heygen-com/hyperframes — Apache-2.0; "Write HTML. Render video. Built for agents."
- https://raw.githubusercontent.com/heygen-com/hyperframes/main/README.md — HTML/CSS/medios a MP4 determinista; Chrome sin ventana + FFmpeg; requisitos Node.js 22+ y FFmpeg; sin cobro por render; instalación como plugin de Claude Code.
- https://raw.githubusercontent.com/heygen-com/hyperframes/main/.claude-plugin/marketplace.json y `plugin.json` — marketplace `hyperframes`, plugins `hyperframes` (recomendado) y `core-skills` (legado); versión 0.8.149.
- https://api.github.com/repos/heygen-com/hyperframes/contents/skills — lista de skills (incluye `embedded-captions`, `talking-head-recut`, `motion-graphics`, `remotion-to-hyperframes`).
- https://registry.npmjs.org/hyperframes/latest — 0.8.149, Apache-2.0, Node >= 22.
- https://api.github.com/repos/heygen-com/hyperframes/commits/main — e1925d4317fcd13c0e5799cd4767a3e2dd4c9238 (2026-10-11).
- https://autoae.online/blog/hyperframes-topic2video-windows-setup (vía búsqueda web, de terceros) — guía de HyperFrames en Windows; dice que sin sesión de HeyGen la narración usa Kokoro. No oficial: sin verificar.

## UI UX Pro Max

- Local: `~/.claude/plugins/marketplaces/ui-ux-pro-max-skill` (README, `.claude-plugin/*.json`, `.claude/skills/*`) — versión 2.13.0, MIT, Copyright 2024 Next Level Builder; instalación por marketplace o `uipro init --ai claude`; Python 3 para su buscador; sub-skills.
- https://api.github.com/repos/nextlevelbuilder/ui-ux-pro-max-skill/commits/main — 67803eac81607188194aea9842a723b89326d90d (2026-10-10).
- https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/.claude-plugin/plugin.json — nombre `ui-ux-pro-max`, MIT, `skills: ./.claude/skills/`.

## Emil Kowalski

- Local: `~/.claude/skills/{emil-design-eng,animate,improve-animations,review-animations,animation-vocabulary}` — sin encabezado de licencia; citan emilkowal.ski y animations.dev.
- Local: `~/.agents/.skill-lock.json` — las cinco vienen de `emilkowalski/skills`.
- https://api.github.com/repos/emilkowalski/skills — licencia MIT; "Skills for Designers and Engineers."
- https://raw.githubusercontent.com/emilkowalski/skills/main/LICENSE — MIT, Copyright (c) 2026 Emil Kowalski.
- https://raw.githubusercontent.com/emilkowalski/skills/main/README.md — 15 skills; instalación `npx skills@latest add emilkowalski/skills`; sin marketplace de plugins.
- https://api.github.com/repos/emilkowalski/skills/contents/ — sin `.claude-plugin`.

## Motion Architect

- Local: `~/.claude/plugins/cache/motion-architect/motion-architect/0.2.0` (`.claude-plugin/marketplace.json`, `plugin.json`, `LICENSE`, `README.en.md`, `install.sh`) — MIT, repo declarado `https://github.com/Hainrixz/motion-architect`; instalador solo macOS/Linux; Node 18+, ffmpeg, yt-dlp, Python 3.
- `git -C "<carpeta local del marketplace>" rev-parse HEAD` — a810275f4fc379ce35eb7ebb3b3ef1c51681e572 (copia local; no se pudo comparar con GitHub).
- https://github.com/Hainrixz/motion-architect y https://api.github.com/repos/Hainrixz/motion-architect — 404 sin autenticación (privado o sin publicar).

## Otros plugins

- Local: `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/{frontend-design,skill-creator}` — autor Anthropic, licencia Apache-2.0.
- https://api.github.com/repos/anthropics/claude-plugins-official — público, Apache-2.0; último commit f359d43b406057f1a8cdbc4ea93b827642c162e6 (2026-10-11).
- Local: `~/.claude/plugins/marketplaces/claude-video` — plugin `watch` 0.2.0, MIT, Bradley Bonanno; usa yt-dlp, ffmpeg y una API de Whisper si no hay subtítulos.
- https://api.github.com/repos/bradautomates/claude-video — público, MIT; último commit 03ceb42f7fa2c4439aca01752118044baabffb8f (2026-09-25).

## Dependencias (macOS y Windows)

- https://api.github.com/repos/ggml-org/whisper.cpp/releases — `v1.9.5` (2026-10-06) sin archivos; los zips de Windows están en `b5454` y anteriores (`whisper-bin-x64.zip`, `whisper-bin-win-cuda-12.4.0-x64.zip`, etc.); `v1.9.2` fue el último release con etiqueta que traía archivos.
- https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip — descargado y listado: `Release/whisper-cli.exe` y `Release/whisper-vad-speech-segments.exe` presentes.
- https://api.github.com/repos/ggml-org/whisper.cpp — licencia MIT.
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/README.md — modelos en https://huggingface.co/ggerganov/whisper.cpp; script `download-ggml-model.sh`.
- https://huggingface.co/ggerganov/whisper.cpp/tree/main — `ggml-large-v3.bin` (3.1 GB) y `ggml-large-v3-turbo.bin` (1.62 GB).
- https://huggingface.co/ggml-org/whisper-vad — modelos VAD en ggml, MIT; archivos `ggml-silero-v5.1.2.bin` y `ggml-silero-v6.2.0.bin`.
- HEAD a los cuatro enlaces `resolve/main/...` de Hugging Face — responden 302 con tamaño 3 095 033 483, 1 624 555 275 y 885 098 bytes (los dos Silero miden lo mismo).
- https://formulae.brew.sh/api/formula/whisper.cpp.json — fórmula `whisper.cpp` 1.9.5 (nombre viejo `whisper-cpp`), MIT.
- https://formulae.brew.sh/api/formula/{node@24,ffmpeg,uv,yt-dlp,git}.json — node@24 24.21.0 (keg-only), ffmpeg 9.0.2, uv 0.13.0, yt-dlp 2026.8.19, git 2.56.0; cask `google-chrome`.
- https://nodejs.org/dist/index.json — Node 24.21.0 es LTS "Krypton"; Node 26.11.1 todavía no es LTS.
- https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/... — existen `Git.Git`, `OpenJS.NodeJS.LTS` (hasta 24.20.0), `Gyan.FFmpeg` y `Gyan.FFmpeg.Essentials`, `astral-sh.uv`, `yt-dlp.yt-dlp`, `Google.Chrome`, `Anthropic.ClaudeCode`; no hay paquete de whisper.cpp.
- https://docs.astral.sh/uv/getting-started/installation/ — `curl -LsSf https://astral.sh/uv/install.sh | sh`, `brew install uv`, `irm https://astral.sh/uv/install.ps1 | iex`, `winget install --id=astral-sh.uv -e`.
- https://docs.astral.sh/uv/guides/install-python/ — `uv python install 3.12`.
- https://www.gyan.dev/ffmpeg/builds/ — los paquetes traen ffmpeg, ffprobe y ffplay; GPLv3; Chocolatey `ffmpeg`.
- https://github.com/yt-dlp/yt-dlp/wiki/Installation — `winget install --source winget --id yt-dlp.yt-dlp`, `choco install yt-dlp`, `scoop install yt-dlp`, `brew install yt-dlp`.
- https://playwright.dev/docs/browsers — instalar navegadores por nombre (`npx playwright install chromium`); en Windows se guardan en `%USERPROFILE%\AppData\Local\ms-playwright`.
- https://pypi.org/pypi/mediapipe/json — 1.1.0, Apache 2.0, wheels `win_amd64`, `win_arm64`, macOS arm64 y Linux.
- https://pypi.org/pypi/rapidocr/json — 3.10.0, Apache-2.0, Python >=3.8,<4.
- https://rapidai.github.io/RapidOCRDocs/main/install_usage/rapidocr/install/ — `pip install rapidocr onnxruntime`; desde 2.0.6 onnxruntime ya no viene incluido.

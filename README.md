# Video Editor Architect

[Español](README.es.md)

An AI reel editor you run with Claude Code. You train **your own** editing style (subtitles, keyword cards, pacing, cuts, sound), and Claude edits your raw videos with it: it decides what goes on screen and when, deterministic scripts do the math, and [Remotion](https://www.remotion.dev) renders the final MP4.

You talk to it in plain language. A setup agent walks you through everything one step at a time, in English or Spanish.

## What it does

- Transcribes your raw footage locally (whisper.cpp) and proposes cuts: silences, dead air and the takes where you repeat yourself. You approve the text before anything is cut.
- Speeds up the take if your style asks for it, without changing the pitch.
- Adds subtitles, keyword cards, typed-out prompts, stickers, sound effects and screen demos according to your style profile.
- Validates the edit against fixed rules (safe zone, timing, overlaps) and reports "passes X of Y rules (Z N/A)".
- Renders at 1440×2560 (and 4K if your footage is 4K) at −14 LUFS, then runs QA with contact sheets.
- Remembers every correction you make in your style profile, so the next reel starts closer to what you want.

## Requirements

| | macOS | Windows |
|---|---|---|
| Install guide | [docs/install-macos.md](docs/install-macos.md) | [docs/install-windows.md](docs/install-windows.md) |
| Node.js | 24 or newer | 24 or newer |
| Also needed | ffmpeg, whisper.cpp, Python with uv, Chrome | ffmpeg, whisper.cpp, Python with uv, Chrome |
| Claude Code | yes | yes |
| Face tracking and OCR | Apple Vision | Python (RapidOCR + MediaPipe in the uv `.venv`) |
| Claude Code sandbox | yes | no on native Windows (yes on WSL2) |

Claude Code's sandbox runs on macOS, Linux and WSL2, not on native Windows: there the rules still apply but nothing enforces them. Whisper and VAD models can be pointed to with `EDITOR_WHISPER_MODELO`, `EDITOR_VAD_MODELO`, `EDITOR_VAD_CLI` and `EDITOR_MODELOS` (models folder); the install guides explain each one.

## First run in 5 steps

1. `git clone <your private copy of this repo> my-editor && cd my-editor`
2. `npm ci` (it also runs `npx tsx herramientas/preparar-public.ts`, which creates the `public/` links: symlinks on macOS/Linux, junctions on Windows; run it again with `npm run preparar`)
3. Open Claude Code in that folder: `claude`
4. Type `/start` (or `/empezar` in Spanish).
5. Answer one question at a time: language, the doctor check, your name and handle, and where your style comes from. Then hand it a raw video.

## Where your style comes from

You pick one:

- **Your own published reels.** Free with yt-dlp or a folder of MP4s. Apify is faster but costs money; the agent tells you the price and waits for your yes.
- **Creators you name** as reference: their top reels or specific videos.
- **`base-neutra`**: a generic starter style, so you can edit your first reel today and train later.

## How your style is stored

Each style is a folder in `estilo/estilos/<id>/`:

- `perfil.md`: the rules in plain words, what never goes, reference numbers (each with its n and source) and the history of your corrections, word for word and dated.
- `perfil.json`: the same values for the code (a `motor` section with speed, air cuts, safe zone, subtitles, cards, stickers and sound).
- `aprendizajes.md`: what worked and what didn't while training it.
- `fuentes.json`: the reels and profiles it was learned from.

The registry is `estilo/estilos/estilos.json`. A style starts as `en-prueba` and becomes `aprobado` when you say so. The profile always wins over the director's draft. More in [estilo/estilos/README.md](estilo/estilos/README.md).

Your profile (`creador.json`), styles and `ESTADO.md` are meant to be committed to **your** private repo.

## What this repo does NOT include

No videos, stickers, sound effects, `.ttf` fonts, memes or logos. Each creator adds their own and records the license of every file in [biblioteca/LICENCIAS.md](biblioteca/LICENCIAS.md). Fonts are downloaded from Google Fonts (OFL) by a script, not shipped.

## Skills

| Command | What it does |
|---|---|
| `/start` · `/empezar` | Guided setup and first reel |
| `/editar` (or "edit this video") | Edits a raw video end to end with a style |
| `/ajustar` | Applies your corrections to an edited reel as a new version |
| `/aprender-estilo` | Learns your style from your own published reels |
| `/entrenar-estilo` | Trains a new style from creators you name |
| `/sfx` | Manages your sound-effects library |
| `/stickers` | Logos and your own PNG stickers |
| `/grabar-demo` | Records a web screen demo to use as an insert |

Recommended extra skills and plugins: [docs/skills.md](docs/skills.md). They are listed in `.claude/settings.json` but do not install themselves: trust the folder in Claude Code and run `claude plugin install <name>@video-editor-architect --scope project` for each one you want.

## Keys and spending

Keys go in `~/.config/claude-editor/.env`, written by you. Claude never reads, prints or asks for them; `npx tsx herramientas/doctor.ts` only says whether each one is present. Anything that costs money (Apify, Gemini) needs your yes in the same turn, and the scripts refuse to run without `--si-gasto=<amount>`.

## Remotion license

Remotion is free for individuals, non-profits, evaluation and companies of up to 3 people. Companies with 4 or more people need a Remotion Company License. Because `render.ts` calls `renderMedia()`, automated rendering may count as "automation" under their terms: check with Remotion if that applies to you. Details: [docs/remotion.md](docs/remotion.md).

## License

The owner of this private repo has not chosen a license yet: see [LICENCIA-PENDIENTE.md](LICENCIA-PENDIENTE.md).

---

Built with [Claude Code](https://claude.com/claude-code).

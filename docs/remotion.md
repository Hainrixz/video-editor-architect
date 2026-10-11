# Remotion in this template

[Español](remotion.es.md)

Checked on 2026-10-11. Sources in [fuentes-investigacion.md](fuentes-investigacion.md).

## What Remotion does here

Claude writes each edit as a JSON file (`proyectos/<slug>/edicion-vN.json`, the EDL). Remotion is the engine that draws it: a React composition called "Reel" reads the EDL and lays out the base video, subtitles, title, keyword cards, stickers, inserts and sound, frame by frame. `herramientas/render.ts` calls Remotion's `selectComposition` and `renderMedia` to produce `salida/final-vN.mp4`. Remotion Studio lets you preview an edit before rendering.

The template pins Remotion **4.0.532** (`package.json`). The latest stable on npm on 2026-10-11 was **4.0.534**. Upgrade on purpose, all `@remotion/*` packages to the same version (the `remotion-upgrade` skill helps).

## License notice (read this)

Remotion is **not** open source under MIT or Apache. It has its own license (`LICENSE.md` in `remotion-dev/remotion`, "Copyright © 2026 Remotion"; the company behind it is Remotion AG).

**Free License.** You can use Remotion for free, including commercially, if you are:

- an individual,
- a for-profit organization or team with **up to 3 people**,
- a non-profit or not-for-profit organization,
- or evaluating it and not yet using it commercially.

**Company License.** Organizations of **4 or more people** (and collaborations of that size) must buy a Company License at remotion.pro/license. Public prices on 2026-10-11:

- **Remotion for Creators:** $25 per month per seat, for people who make videos for their organization by hand or with AI agents and Remotion Studio.
- **Remotion for Automators:** $0.01 per render with a $100 per month minimum, for automations and video products.
- Combined minimum spend: $100 per month. **Enterprise** starts at $500 per month.

**Why this matters for this template.** Remotion's FAQ defines an "automation" as owning code that programmatically calls `renderMedia()` (among others) or `npx remotion render`. This template's `render.ts` calls `renderMedia()`. If you are in an organization of 4+ people, check with Remotion whether you need Creators seats, Automators, or both. This is **not verified** for this specific use; ask Remotion (their License FAQ gives a contact email). Free License users don't pay per render.

Using this template does not give you a Remotion license. Each person or company that clones it is responsible for its own.

## Requirements by system

Remotion's own requirements (docs, 2026-10-11): Node 16+ or Bun 1.0.3+. This template needs **Node 24+** (`package.json` → `engines`).

- **macOS:** macOS **15 (Sequoia) or later**; older versions are not supported.
- **Windows:** supported on **x64 only** (from the v4.0 migration guide). The rendering browser exists for Windows x64.
- **Linux (and WSL2):** glibc 2.35 or newer plus some extra packages listed in Remotion's Linux dependencies page. Alpine and NixOS are not supported.

**Chrome Headless Shell.** Remotion downloads it automatically into `node_modules/.remotion/chrome-headless-shell/<platform>/` the first time it renders (macOS x64/arm64, Windows x64, Linux x64/arm64). You can download it ahead of time with `npx remotion browser ensure`. It does not work inside Claude Code's macOS sandbox; that is why render commands are in `excludedCommands`.

**FFmpeg.** Remotion 4 bundles its own small FFmpeg (the CLI docs say 7.1 release line; the v4.0 migration guide still says 6.0) and FFprobe inside `@remotion/renderer`, callable with `npx remotion ffmpeg` and `npx remotion ffprobe`. It only knows the codecs Remotion supports (H.264, H.265, VP8, VP9, ProRes). This template's other tools (ingest, cuts, base video, loudness, QA) call the **system** `ffmpeg` and `ffprobe`, so you still install them: see [install-macos.md](install-macos.md) and [install-windows.md](install-windows.md).

## Remotion agent skills

Remotion publishes official skills for coding agents (`npx skills add remotion-dev/skills`). They are not included in this repo. See [skills.md](skills.md).

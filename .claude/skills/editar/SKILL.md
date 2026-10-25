---
name: editar
description: Edits a creator's reel end to end with their style (cuts, subtitles, title, keyword cards, typed prompts, stickers, SFX, screen demos) and delivers the final MP4. Edita un reel de principio a fin con el estilo del creador y entrega el MP4 final. Use with /editar <video>, or when they say "edit", "edit this video", "make the reel from this raw", "edit it like my reels", "edita este video", "hazme el reel de este crudo", "edítalo como mis reels".
argument-hint: "<path to raw video> [notes: topic, demo URL, keywords]"
---
<!-- Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) · tododeia.com · id er-2f298797 -->

# /editar <crudo>

Respond in the creator's language (`creador.json` → `idioma`: es/en).

You are the **director**: you decide what happens and when; the tools compute and Remotion renders. Rules that never break are in `CLAUDE.md` (money only with a yes, never keys, originals untouched).

`herramientas/editar.ts` chains the stages and stops at each checkpoint. It is excluded from the sandbox: run it **alone** in its Bash call (no `cd`, `&&` or pipes).

## 0. Before starting
- **Style:** if the creator named one ("with my style", "with style X"), use it. **If not, ask before directing: "Which style do you want to use?"** (AskUserQuestion: the options in `estilo/estilos/estilos.json`, approved ones first, then `base-neutra`, plus "Train a new one"), even if there is only one. Write the choice to `notas-director.json` → `"estilo": "<id>"`. If there is no `creador.json`, suggest `/empezar` first.
- **Read the chosen profile: `estilo/estilos/<id>/perfil.md` + `perfil.json`** (and `aprendizajes.md`). Those are the creator's approved decisions and **win over this skill** when they clash: speed, how hard to cut air, whether layers may cover the face, cards per minute, whether stickers or memes go at all, which SFX sources are allowed. When they correct something or approve a final, update that profile and its history.
- If they bring notes (topic, a URL for a demo, words to highlight), keep them for step 2. If something only they know is missing (for example the site they want to show), ask **once and all together**.
- If they said you have full control or not to stop, run everything and document your decisions in the report; otherwise stop at each checkpoint.

## 1. Text (checkpoint 1)
```
npx tsx herramientas/editar.ts <crudo> [--slug YYYY-MM-DD-topic]
```
Ingest (the original is not touched), transcription (whisper + second opinion + brand names) and the proposed cuts.
- Read `proyectos/<slug>/texto-propuesto.md`. Check misspelled names (brands, products, people): if you find one, add it to `biblioteca/vocabulario.json` → `correcciones` and run `npx tsx herramientas/transcribir.ts <slug>` again (reuses the cache, takes seconds) and `npx tsx herramientas/cortes.ts <slug>`.
- As director, remove filler words or stray words that get in the way, and the takes where they repeat or correct themselves, but never change the meaning or the order: you can only remove or restore what was said.
- Show the creator the final script (or, with full control, decide and note it).

## 2. Base, face, framing, subtitles and direction (checkpoint 2)
```
npx tsx herramientas/editar.ts --slug <slug> --aprobar-texto [texto-aprobado.md]
```
Cuts from the approved text → 1440×2560 base at the style's speed (pitch unchanged) → face (chin and mouth per frame) → reframing if the raw is wider than the creator's reels (from 4K; never zooms out) → subtitles → **direction draft** (`direccion.json` + `direccion.md`).

Now you decide. Read `direccion.md`, the style profile and `estilo/estilo.json` if it exists, and improve the draft by writing `proyectos/<slug>/notas-director.json`:
- **Title:** only if the style uses one (the profile says "always", "never" or "decide per reel"). Two lines of ≤ 24 characters, in the creator's voice: a number, "you", or tension.
- **Cards** (keyword highlights; how many per minute and how many words come from the profile):
  - Literal words they say, capitalized; numbers as digits ("15 employees", "$20").
  - Lists: stacked when they enumerate, one card per item with the same `grupo`; they leave together.
  - Prompt: when they say "tell Claude / ask it / type to…", a `prompt` card types itself in so viewers can copy it. `direccion.md` → "Prompts dictados" gives you the span; write the text **complete and literal** (no filler) in `tarjetas_forzadas`: `{"texto": "…", "variante": "prompt", "desde_palabra": "<first word of the prompt>"}` (no `grupo`). Over ~120 characters it splits into consecutive cards on its own; to choose the split, add two `prompt` cards with their own `desde_palabra`. `"hasta"` sets the end. If their SFX library has a typing sound, the director adds it.
- **Remove something from the draft:** `"quitar": ["Minutes", "sticker:money"]` by **text** (or sticker concept). Ids like `t3`/`k2` shift when the draft changes.
- **Hook:** something on screen before ~1.3 s unless the profile says otherwise. The director already checks it; review it in `direccion.md`.
- **Stickers** (only if the style uses them and the library has them): a logo on the first strong mention of a brand, once per brand; their own PNGs by concept. Never the same asset twice in a reel. To force one: `"stickers_forzados": [{"id_catalogo": "logo-github-tile", "desde_palabra": "GitHub#2"}]` (`#n` = the n-th time they say it). Missing a logo: `/stickers`.
- **Demos and inserts:** when they say to open a site or do something on screen, record it with `/grabar-demo` and place it with its timing; their own screenshots or B-roll go through `npx tsx herramientas/procesar-inserts.ts <slug> <file>`.
- **SFX:** the picker places them (no repeats, part of the layers in silence) from the sources allowed in `creador.json` → `sfx.solo_fuentes`. Do not pick by hand without a reason. Empty library → no SFX, and say so.
- **Memes and zooms:** only if the profile includes them.

Then `npx tsx herramientas/director.ts <slug>` (applies your notes) and read `direccion.md` again.

## 3. Draft and review (checkpoint 3)
```
npx tsx herramientas/editar.ts --slug <slug> --borrador
```
Builds `edicion-vN.json`, validates it (any FAIL from `validar.ts` gets fixed before moving on: at most 2 self-corrections, then ask), renders a 720p draft and runs QA. Then:
- Launch the **revisor-qa** agent on the slug and version; fix what blocks publishing.
- Look at the contact sheets yourself (`proyectos/<slug>/qa/vN/hoja-*.jpg`) with Read: nothing over the face unless the style allows it, cards say what they say, stickers do not overlap subtitles.
- To change something: `npx tsx herramientas/ajustar.ts <slug> --desde N` and edit `edicion-v(N+1).json` (see `/ajustar`).

## 4. Final
```
npx tsx herramientas/editar.ts --slug <slug> --final --version N
```
Renders 1440×2560 at −14 LUFS / −1.5 dBTP, final QA and `reporte.md`. If the raw is 4K and the style or the creator asks for it: `npx tsx herramientas/base.ts <slug> --cortes proyectos/<slug>/cortes.json --4k` and `npx tsx herramientas/render.ts <slug> --version N --4k`.

Deliver: the path of `salida/final-vN.mp4`, "passes X of Y checks (Z N/A)", what you decided as director and what is pending from the creator. Write any correction they give to the profile history (literal, dated).

## Without stopping (full control)
```
npx tsx herramientas/editar.ts <crudo> --todo [--slug s]
```
Runs everything with the proposed text and the direction draft; then review (step 3) and, if you change something, make another version with `/ajustar` before delivering.

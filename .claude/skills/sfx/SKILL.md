---
name: sfx
description: Manages the creator's own sound-effects library - add their sounds with a license, catalog them, pick SFX for an edit without repeats, review the catalog. Maneja la biblioteca propia de efectos de sonido - agregar sonidos con licencia, catalogarlos y elegirlos para una edición sin repetir. Use with /sfx or when they say "change the sounds", "more SFX variety", "add this sound", "cámbiale los sonidos", "más variedad de SFX", "agrega este sonido".
argument-hint: "elegir <slug> | revisar | agregar <file|folder> | aprobar-pop"
---

# /sfx

Respond in the creator's language (`creador.json` → `idioma`: es/en).

The repo ships **no sounds**. The library is the creator's: `biblioteca/sfx/<category>/*.wav` (normalized: 48 kHz, attack at sample 0, peak −1 dBTP) plus `biblioteca/sfx/catalogo.json`. Every source file has its license row in `biblioteca/LICENCIAS.md`. Categories: pop, burbuja, pluck, brillo, blip, clic, toque, whoosh, impacto, tecla, glitch and especial (long or gag sounds, placed by hand in `sfx_extra`; a long keyboard typing sound here is what `prompt` cards use).

## Add their sounds
Only with a clear license: their own recordings, CC0, or a license they hold. Never download from sites without a license; Freesound only CC0 and downloaded by them with its URL noted.
1. They put the originals in a folder inside the project (for example `biblioteca/sfx/_originales/propios/`). Originals are read, never modified.
2. Write `biblioteca/sfx/seleccion.json` with the file tools:
   ```json
   {"fuente": "propios", "carpeta": "biblioteca/sfx/_originales/propios", "licencia": "own recording",
    "archivos": {"<name without extension>": {"categoria": "pop"}, "typing": {"categoria": "especial", "nota": "keyboard"}}}
   ```
   Listen-free hint: ask them what each file is if the name does not say it; short clicks → clic/toque, bubbly → burbuja/pop, air → whoosh, long or funny → especial.
3. Catalog: `npx tsx herramientas/sfx/catalogar.ts --sin-red` (normalizes, makes ±1 semitone variants, writes the catalog). Files not listed in `seleccion.json` are reported and left out.
4. Optional free CC0 packs from Kenney (kenney.nl): `npx tsx herramientas/sfx/catalogar.ts` without `--sin-red` downloads and verifies them. Their drop/pluck/tick only count as "pop" after the creator listens to `out/f3-sfx/hoja-pop.wav` and says which: `--aprobar-pop=1,4,7` (or `=ninguno`).
5. Add one row per file to `biblioteca/LICENCIAS.md`.

## Which sources are allowed
`creador.json` → `sfx.solo_fuentes`: empty = every source in the catalog; `["propios"]` (the `fuente` written in `biblioteca/sfx/seleccion.json`) = only theirs. `elegir.ts --solo-fuente a,b` or `--todas-las-fuentes` override it for one run. Ask before widening it.

## Pick for an edit
```
npx tsx herramientas/sfx/elegir.ts --edicion proyectos/<slug>/edicion-vN.json --salida proyectos/<slug>/edicion-v(N+1).json
```
Add `--guardar-historial` only on the version rendered as final (so it does not repeat across videos). Rules: no file (or its pitch variants) in the last 5 events with sound; no category more than 2 times in a row; part of the layers stay silent; starts 0–2 frames around the appearance.

## Review
`npx tsx herramientas/sfx/catalogar.ts --solo-revisar` counts sources per category (a category needs ≥ 5 to enter the event mapping). With an empty or tiny library, say so: the director places fewer or no sounds.

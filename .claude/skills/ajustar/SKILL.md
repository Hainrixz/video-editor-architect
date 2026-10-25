---
name: ajustar
description: Applies the creator's corrections to an already edited reel ("move the sticker down", "remove that SFX", "change the card", "shorter title") as a new version without touching the previous one; if it is a general preference, saves it to the style profile. Aplica correcciones a un reel ya editado en una versión nueva y guarda las preferencias en el perfil del estilo. Use with /ajustar "<change>" or when they say "adjust", "fix this in the reel", "change the card", "ajusta", "cámbiale", "baja el sticker", "quita ese sonido".
argument-hint: "\"<what to change>\" [slug]"
---
<!-- Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) · tododeia.com · id er-2f298797 -->

# /ajustar "<change>"

Respond in the creator's language (`creador.json` → `idioma`: es/en).

1. **Find the project and version:** the creator names the slug, or it is the last one edited (`ls -t proyectos/ | head`). The version is the highest `edicion-vN.json`.
2. **Copy the version:** `npx tsx herramientas/ajustar.ts <slug> --desde N` creates `edicion-v(N+1).json` (vN stays read-only).
3. **Edit the new version** with the file tools, changing ONLY what they asked. Examples:
   - "move k2 down 100 px" → `stickers[id=k2].caja.y += 100` (base coordinates 1080×1920; `caja.x`/`caja.y` = center).
   - "remove the SFX on k5" → `stickers[id=k5].sfx = null`.
   - "change the card 'Free' to 'No cost'" → `tarjetas[id=…].texto`.
   - "the title should say …" → `titular.texto` (2 lines with `\n`, ≤ 24 characters each).
   - A new sticker: make it with `/stickers` (logo or their own PNG) and add it with its timing; its SFX comes from `npx tsx herramientas/sfx/elegir.ts --edicion <v(N+1)> --salida <v(N+2)>`.
4. **Check the diff:** `npx tsx herramientas/ajustar.ts <slug> --desde N` (if v(N+1) already exists, it validates it and prints the changes). It must contain exactly what they asked.
5. **Render:** `npx tsx herramientas/render.ts <slug> --version N+1` and `npx tsx herramientas/qa.ts <slug> --version N+1` (excluded: each alone in its Bash call). Show what changed, with numbers.
6. **General preferences** ("never put stickers above X", "bigger cards", "faster"): besides the change, save it in the active style (`notas-director.json` → `estilo`, or `creador.json` → `estilo_activo`):
   - The creator's words, **literal and dated**, in the history of `estilo/estilos/<id>/perfil.md`, and the rule updated above it.
   - A value the engine reads (speed, air cuts, safe zone, whether layers may cover the face, pace) → `perfil.json` → `motor` (shape in `herramientas/lib/perfil-estilo.ts`), with a `decision` that quotes them.
   - A rule that should be checked automatically (and the profile cannot express) → propose a new rule in `herramientas/validar.ts` with its test, and wait for their yes before changing code.
   - Offer one commit per change, with a message in the creator's language.

Never overwrite a version or a final already delivered.

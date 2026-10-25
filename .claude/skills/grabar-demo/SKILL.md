---
name: grabar-demo
description: Records a web screen demo (Chrome, 2560×1600) with clicks, scroll and zoom on click, to use as an insert in a reel. Graba una demo de pantalla web con clics, scroll y zoom al clic para meterla como insert en un reel. Use with /grabar-demo <url> or when the director needs to show a site or tool on screen, or they say "record a demo", "show the site", "graba una demo", "muestra la página".
argument-hint: "<url> [what to show]"
---
<!-- Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) · tododeia.com · id er-2f298797 -->

# /grabar-demo <url>

Respond in the creator's language (`creador.json` → `idioma`: es/en).

Records with `herramientas/grabador/estudio.ts` (excluded command: **alone** in its Bash call, no `cd`, `&&` or pipes).

1. **Slug and folder:** `demos/<slug>/` (for example `reel12-github`). Write with the file tools:
   - `sitios.txt`: one domain per line; navigating outside the list is blocked.
   - `guion.json`: `{version:1, descripcion, tema, pasos:[…]}`.
     - Steps: `ir` (url), `esperar` (ms), `scroll` (px, duracion_ms), `clic` (css selector, or role + name), `escribir` (text; `sensible:true` if it must not be saved), `tecla`, `captura`.
     - Risk: every step has `riesgo`: `lectura`, `escritura`, `gasto` or `publica`. Anything that is not reading exits with code 3 before running, unless the script has `aprobado: true` **with the creator's yes in this turn**.
     - Theme: `oscuro` by default (white text reads well on top). `oscuro-forzado` for sites without dark mode, `claro` only if they ask, or if their style profile says so (`perfil.json` → `demos.tema`).
   - `ocultar.json` (optional): extra CSS selectors to blur (on top of passwords, cards and token fields).
2. **Explore first** (optional): `npx tsx herramientas/grabador/estudio.ts explorar <url> --slug <slug> --sin-sesion` leaves a PNG in `demos/<slug>/capturas/` so you can see the page and pick selectors.
3. **Record:** `npx tsx herramientas/grabador/estudio.ts grabar <slug> --guion demos/<slug>/guion.json --sin-sesion` (drop `--sin-sesion` if the site needs the creator's session). Outputs `toma.mp4` (CFR 30, 2560×1600), `eventos.json` (clicks and scroll, no typed text) and `revision.json`.
4. **Secrets:** if `revision.json` says BLOQUEADA, do not use it or approve it yourself. Look at which second and where the finding is. If the reel does not need that part, trim the script to avoid it and record again with `--reemplazar` (the previous take stays in `anteriores/`). If it does, tell the creator what was detected (redacted) and that they approve it themselves with `! npx tsx herramientas/grabador/estudio.ts revision <slug> --aprobar`.
5. **Put it in the reel:** in `notas-director.json` → `inserts` (or directly in the EDL) an insert `tipo:"demo"` with `asset:"demos/<slug>/toma.mp4"`, `eventos:"demos/<slug>/eventos.json"`, `layout:"pantalla-completa"` (vertical framing with zoom on click) or `"tarjeta"` (horizontal box), `trim_desde` and its timing. `DemoPantalla` draws the zoom, cursor and click ripple. Keep it as short as the style asks.

**Session:** for sites with login, the creator signs in by hand once: `! npx tsx herramientas/grabador/estudio.ts --login <url>` (it does not record or read cookies). Claude never types passwords or looks at the profile.
**Terminal:** to show commands, use an animated terminal demo (`demos/<slug>/<x>.terminal.json`, contract in `src/estilo/terminal.ts`) as an insert `tipo:"demo"` with that asset; never invent output the tool would not produce. A native window can be recorded with `npx tsx herramientas/grabador/ventana.ts --app Terminal --segundos 10 --salida demos/<slug>/terminal.mp4` (excluded; needs the screen recording permission).

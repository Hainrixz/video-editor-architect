---
name: stickers
description: Makes or processes stickers for the creator's reels from licensed brand logos and their own PNG images. Crea o procesa stickers para los reels con logos de marca con licencia y PNG propios del creador. Use with /stickers or when they say "make me a sticker of…", "add the logo of…", "process my stickers", "hazme un sticker de…", "agrega el logo de…", "procesa mis stickers".
argument-hint: "logo <brand> | procesar <folder>"
---
<!-- Copyright (c) 2026 Enrique Rocha (@soyenriquerocha) · tododeia.com · id er-2f298797 -->

# /stickers

Respond in the creator's language (`creador.json` → `idioma`: es/en).

The repo ships **no stickers**. Every sticker ends up with a transparent background (the 4 corners at α = 0), a white sticker-style border, its row in the catalog of its folder (`biblioteca/stickers/<source>/catalogo.json`) and its license row in `biblioteca/LICENCIAS.md`. Whether stickers go in a reel at all, and how many per minute, is decided by the style profile.

## 1. Brand logos (free)
```
npx tsx herramientas/stickers/logo.ts --marcas github,figma,…
npx tsx herramientas/stickers/logo.ts --lista
```
Sources at a fixed commit: Simple Icons (CC0) for one-color logos and svgl (MIT) for multi-color ones. Two variants: `tile` (white rounded square with the logo and the name) and `solo`. Never recolored or distorted. Brands that are in neither source stay out, and you say so. A brand's trademark is still the brand's: use it to refer to it, not as if it were the creator's.

The director puts a logo on the first strong mention of a brand, once per reel. To force one: `notas-director.json` → `"stickers_forzados": [{"id_catalogo": "logo-github-tile", "desde_palabra": "GitHub#2"}]`.

## 2. Their own PNGs (free)
Images they made or hold a license for (drawings, cutouts, images made with tools whose terms allow it). They leave them in a folder under `entrada/` (read only). Then, **alone** in its Bash call (excluded from the sandbox):
```
npx tsx herramientas/stickers/procesar.ts entrada/stickers/ --destino biblioteca/stickers/propios --etiquetas concepto1,concepto2
```
Always with the folder as argument. On macOS the cutout uses Apple Vision; if it drops pieces or text, offer `--metodo color` (and `--forzar` to redo one). Then check the catalog entries have good tags (what each sticker means: "money", "fast", "done"), since the director picks by concept.

## 3. Paid image generators (optional)
If the creator connects a paid image service, it follows the house rule: **one** generation per request, only if they asked in this turn, and **before** you say what you will generate and what it costs. Never in batches or "variants just in case". The result goes through step 2.

Never repeat the same asset twice in a reel.

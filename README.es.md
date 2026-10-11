# Video Editor Architect

[English](README.md)

Un editor de reels con IA que corres con Claude Code. Entrenas **tu propio** estilo de edición (subtítulos, tarjetas de palabras clave, ritmo, cortes, sonido) y Claude edita tus crudos con él: decide qué sale en pantalla y cuándo, los scripts hacen las cuentas y [Remotion](https://www.remotion.dev) renderiza el MP4 final.

Le hablas normal. Un agente de configuración te guía paso a paso, una cosa a la vez, en español o en inglés.

## Qué hace

- Transcribe tu crudo en tu máquina (whisper.cpp) y te propone los cortes: silencios, aires y las tomas donde te repites. Tú apruebas el texto antes de cortar nada.
- Acelera la toma si tu estilo lo pide, sin cambiar el tono de tu voz.
- Pone subtítulos, tarjetas de palabras clave, prompts que se escriben solos, stickers, efectos de sonido y demos de pantalla según tu perfil de estilo.
- Valida la edición con reglas fijas (zona segura, tiempos, encimados) y te dice "cumple X de Y reglas (Z N/A)".
- Renderiza a 1440×2560 (y en 4K si tu crudo es 4K) a −14 LUFS y corre QA con hojas de contacto.
- Guarda cada corrección tuya en tu perfil de estilo, así el siguiente reel arranca más cerca de lo que quieres.

## Requisitos

| | macOS | Windows |
|---|---|---|
| Guía de instalación | [docs/instalar-macos.es.md](docs/instalar-macos.es.md) | [docs/instalar-windows.es.md](docs/instalar-windows.es.md) |
| Node.js | 24 o más nuevo | 24 o más nuevo |
| También | ffmpeg, whisper.cpp, Python con uv, Chrome | ffmpeg, whisper.cpp, Python con uv, Chrome |
| Claude Code | sí | sí |
| Cara y OCR | Apple Vision | Python (RapidOCR + MediaPipe en el `.venv` de uv) |
| Sandbox de Claude Code | sí | no en Windows nativo (sí en WSL2) |

El sandbox de Claude Code corre en macOS, Linux y WSL2, no en Windows nativo: ahí las reglas siguen valiendo, pero nada las hace cumplir. Los modelos de whisper y del VAD se pueden apuntar con `EDITOR_WHISPER_MODELO`, `EDITOR_VAD_MODELO`, `EDITOR_VAD_CLI` y `EDITOR_MODELOS` (carpeta de modelos); las guías explican cada una.

## Primer uso en 5 pasos

1. `git clone <tu copia privada de este repo> mi-editor && cd mi-editor`
2. `npm ci` (también corre `npx tsx herramientas/preparar-public.ts`, que crea los accesos de `public/`: symlinks en macOS/Linux, junctions en Windows; vuelve a correrlo con `npm run preparar`)
3. Abre Claude Code en esa carpeta: `claude`
4. Escribe `/empezar` (o `/start` en inglés).
5. Contesta una pregunta a la vez: idioma, la revisión del doctor, tu nombre y tu cuenta, y de dónde sale tu estilo. Luego pásale un crudo.

## De dónde sale tu estilo

Eliges una:

- **Tus propios reels publicados.** Gratis con yt-dlp o con una carpeta de MP4. Apify es más rápido pero cuesta; el agente te dice cuánto y espera tu sí.
- **Creadores que tú nombres** como referencia: sus top reels o videos concretos.
- **`base-neutra`**: un estilo genérico de arranque, para editar tu primer reel hoy y entrenar después.

## Cómo se guarda tu estilo

Cada estilo es una carpeta en `estilo/estilos/<id>/`:

- `perfil.md`: las reglas en palabras normales, lo que nunca va, los números de referencia (cada uno con su n y su fuente) y el historial de tus correcciones, literal y con fecha.
- `perfil.json`: los mismos valores para el código (una sección `motor` con velocidad, aires, zona segura, subtítulos, tarjetas, stickers y sonido).
- `aprendizajes.md`: qué funcionó y qué no al entrenarlo.
- `fuentes.json`: los reels y perfiles de donde salió.

El registro es `estilo/estilos/estilos.json`. Un estilo empieza `en-prueba` y pasa a `aprobado` cuando tú lo dices. El perfil siempre manda sobre el borrador del director. Más en [estilo/estilos/README.md](estilo/estilos/README.md).

Tu perfil (`creador.json`), tus estilos y `ESTADO.md` se versionan en **tu** repo privado.

## Lo que este repo NO trae

Ni videos, ni stickers, ni efectos de sonido, ni fuentes `.ttf`, ni memes, ni logos. Cada creador pone los suyos y anota la licencia de cada archivo en [biblioteca/LICENCIAS.md](biblioteca/LICENCIAS.md). Las fuentes se bajan de Google Fonts (OFL) con un script; no vienen en el repo.

## Skills

| Comando | Qué hace |
|---|---|
| `/empezar` · `/start` | Configuración guiada y primer reel |
| `/editar` (o "edita este video") | Edita un crudo de principio a fin con un estilo |
| `/ajustar` | Aplica tus correcciones a un reel ya editado en una versión nueva |
| `/aprender-estilo` | Aprende tu estilo de tus reels publicados |
| `/entrenar-estilo` | Entrena un estilo nuevo a partir de creadores que tú nombres |
| `/sfx` | Maneja tu biblioteca de efectos de sonido |
| `/stickers` | Logos y tus propios stickers en PNG |
| `/grabar-demo` | Graba una demo de pantalla web para usarla como insert |

Skills y plugins recomendados: [docs/habilidades.es.md](docs/habilidades.es.md). Vienen anotados en `.claude/settings.json`, pero no se instalan solos: confía en la carpeta en Claude Code y corre `claude plugin install <nombre>@video-editor-architect --scope project` por cada uno que quieras.

## Llaves y gastos

Las llaves van en `~/.config/claude-editor/.env` y las escribes tú. Claude nunca las lee, ni las imprime, ni te las pide; `npx tsx herramientas/doctor.ts` solo dice si cada una está. Todo lo que cuesta (Apify, Gemini) necesita tu sí en el mismo turno, y los scripts no corren sin `--si-gasto=<monto>`.

## Licencia de Remotion

Remotion es gratis para personas, organizaciones sin fines de lucro, evaluación y empresas de hasta 3 personas. Las empresas de 4 o más necesitan la Company License de Remotion. Como `render.ts` llama a `renderMedia()`, el render automático puede contar como "automation" en sus términos: consúltalo con Remotion si te aplica. Detalles: [docs/remotion.es.md](docs/remotion.es.md).

## Licencia

El dueño de este repo privado todavía no elige licencia: mira [LICENCIA-PENDIENTE.md](LICENCIA-PENDIENTE.md).

---

Hecho con [Claude Code](https://claude.com/claude-code).

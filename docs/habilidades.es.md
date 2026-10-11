# Habilidades y plugins para esta plantilla

[English](skills.md)

Ninguna de estas habilidades viene dentro del repo. Cada una se instala aparte, desde su autor y con su propia licencia. Aquí tienes para qué sirve cada una, cómo instalarla y qué licencia tiene. Todo se revisó el 2026-10-11; las fuentes están en [fuentes-investigacion.md](fuentes-investigacion.md).

## Qué usar para qué

- **Editar un reel (cortes, subtítulos, tarjetas, render):** las habilidades de la plantilla (`/editar`, `/ajustar`, `/entrenar-estilo`) más las **skills oficiales de Remotion**.
- **Subtítulos:** `remotion-captions` (Remotion). Si armas un clip con HyperFrames, ese trae su propia `embedded-captions`.
- **Motion graphics:** dentro del proyecto, las skills de Remotion (`remotion-markup`); para clips sueltos hechos en HTML, **HyperFrames**; para piezas completas con storyboard, **Motion Architect** (solo macOS y Linux).
- **Diseño (paletas, tipografías para subtítulos, tarjetas y titular, design tokens):** **UI UX Pro Max** y **frontend-design** de Anthropic.
- **Que la animación se sienta bien (curvas, tiempos, resortes):** las **skills de Emil Kowalski** (`emil-design-eng`, `animate`, `review-animations`, `improve-animations`, `animation-vocabulary`).
- **Estudiar videos de referencia para un estilo nuevo:** **watch** (claude-video).
- **Video de lanzamiento de un proyecto:** **BRAG** (`/brag`, `/brag-slim`).
- **Escribir tus propias habilidades:** **skill-creator** de Anthropic.

## Cómo recomienda plugins el repo

El `.claude/settings.json` de la plantilla declara un marketplace chico y los plugins que sugiere (el bloque exacto está en [marketplaces.json](marketplaces.json)). Cada plugin va fijado a un commit (`sha`), así todos usan la misma versión hasta que la plantilla mueva ese sha.

Lo que pasa al abrir el repo:

1. Claude Code te pregunta si confías en la carpeta. El marketplace solo se registra cuando aceptas.
2. Los plugins que vienen de un repo de GitHub **no se instalan solos**. Claude Code te avisa `Plugin "<nombre>" is enabled in project settings but isn't installed`. Instala los que quieras:

```bash
claude plugin install ui-ux-pro-max@video-editor-architect --scope project
claude plugin install hyperframes@video-editor-architect --scope project
claude plugin install brag@video-editor-architect --scope project
claude plugin install watch@video-editor-architect --scope project
claude plugin install frontend-design@claude-plugins-official --scope project
claude plugin install skill-creator@claude-plugins-official --scope project
```

3. Para apagar uno que el proyecto enciende, ponlo en `false` en `.claude/settings.local.json` (solo cambia en tu máquina).

Las skills que no son plugins de Claude Code (las de Remotion y las de Emil Kowalski) se instalan con la CLI `skills`, como se ve abajo.

## Skills oficiales de Remotion

- **Qué son:** `remotion-best-practices` reparte el trabajo entre las demás: `remotion-create`, `remotion-markup` (composiciones, tiempos, fuentes, audio, transiciones, medir texto, motion blur, light leaks y más), `remotion-captions` (transcribir, importar SRT, mostrar y animar subtítulos), `remotion-studio`, `remotion-render`, `remotion-multimedia` (metadatos con Mediabunny), `remotion-interactivity`, `remotion-maps`, `remotion-saas`, `remotion-docs` (busca en la documentación y la trae en Markdown) y `remotion-upgrade`. Versión revisada: 4.0.533.
- **Instalar:** `npx skills add remotion-dev/skills` (o `npx remotion skills add` dentro de un proyecto de Remotion).
- **Licencia:** el repo `remotion-dev/skills` no tiene archivo de licencia (GitHub no reporta ninguna). No se incluye aquí; se instala desde Remotion. Usar Remotion tiene su propia licencia: lee [remotion.es.md](remotion.es.md).

## UI UX Pro Max

- **Qué es:** una base de diseño local con buscador (versión 2.13.0: 79 estilos, 192 paletas, 74 parejas de tipografías y un generador de sistema de diseño), con las sub-skills `design-system` (tokens en tres capas), `brand`, `design`, `banner-design`, `slides` y `ui-styling`.
- **Para este editor:** eliges una paleta y una pareja de tipografías para subtítulos, tarjetas y titular, y las guardas como design tokens en el perfil de tu estilo. Su buscador necesita Python 3 (solo la biblioteca estándar).
- **Ojo:** la sub-skill `design` puede generar logos con servicios de IA de pago (Gemini y otros). Eso cuesta dinero; pregunta antes de usarla.
- **Instalar:** viene en el marketplace del proyecto, o a mano: `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill` y `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`.
- **Licencia:** MIT (Copyright 2024 Next Level Builder).

## frontend-design y skill-creator (Anthropic)

- **frontend-design:** guía para interfaces con carácter, que no se vean genéricas. Sirve para el look de tarjetas, titulares y cualquier demo web que grabes.
- **skill-creator:** crea, prueba y afina habilidades; por ejemplo, una que capture tu estilo de edición.
- **Instalar:** `claude-plugins-official` es el marketplace oficial de Anthropic y no necesita entrada extra. `/plugin install frontend-design@claude-plugins-official` y `/plugin install skill-creator@claude-plugins-official`.
- **Licencia:** Apache-2.0. Los plugins del marketplace oficial no se pueden fijar a un sha desde este repo; se actualizan solos.

## HyperFrames (HeyGen)

- **Qué es:** un framework de código abierto que convierte HTML, CSS, medios y animaciones con búsqueda por tiempo (GSAP, CSS, Lottie, Three.js y otras) en MP4 deterministas. Dibuja cada cuadro en Chrome sin ventana y codifica con FFmpeg. Entre sus skills están `hyperframes`, `motion-graphics`, `embedded-captions`, `talking-head-recut` y `remotion-to-hyperframes`.
- **Cómo se complementa con Remotion:** Remotion sigue siendo el motor del editor (React, la EDL, el render final). HyperFrames te sirve para una pieza de motion suelta escrita en HTML, que luego metes al reel como insert (un clip MP4). La edición final se queda en Remotion.
- **Requisitos:** Node.js 22 o más y FFmpeg. Soporte oficial en Windows: **sin verificar** (el sitio ofrece apps de escritorio para macOS y Linux).
- **Instalar:** viene en el marketplace del proyecto, o `claude plugin marketplace add heygen-com/hyperframes` y `claude plugin install hyperframes@hyperframes`. En otros agentes: `npx skills add heygen-com/hyperframes`.
- **Licencia:** Apache-2.0. Su README dice que no cobra por render ni tiene topes de uso comercial. Las voces de HeyGen piden iniciar sesión en HeyGen; sin sesión, la narración usa Kokoro en local (fuente de terceros, sin verificar en lo oficial).

## BRAG

- **Qué es:** un plugin de Claude Code de Shunit Haviv Hakimi que convierte un proyecto en un video de lanzamiento de 15 a 25 segundos, con música, movimiento y texto para compartir. `/brag` usa HyperFrames; `/brag-slim` arma todo el video con lo que ya hay en la máquina, y en Claude Opus 5.5 `/brag` se pasa solo a `/brag-slim` (`/brag --full` mantiene el flujo con HyperFrames).
- **Para este editor:** una forma rápida de hacer la promo de tu editor o de cualquier proyecto. No es parte del flujo de un reel.
- **Requisitos:** Node.js 22+, FFmpeg en el PATH y, para `/brag`, la CLI de HyperFrames (`npx hyperframes doctor`). En Windows su README pide `core.symlinks=true` en Git y el Modo de desarrollador o permisos de administrador para sus symlinks; si no, copia `skills/brag/` a mano.
- **Instalar:** viene en el marketplace del proyecto, o `/plugin marketplace add latent-spaces/brag` y `/plugin install brag@brag`. Solo `/brag-slim`: `npx skills add https://github.com/latent-spaces/brag --skill brag-slim`.
- **Licencia:** MIT (Copyright 2026 Shunit Haviv Hakimi). Su README acredita la música a ende.app y los SFX a Kenney.

## watch (claude-video)

- **Qué es:** `/watch <url o archivo>` baja el video con yt-dlp, saca cuadros con ffmpeg y toma los subtítulos o una transcripción, para que Claude lo vea. Sirve en `/entrenar-estilo` para estudiar a los creadores que tú nombres como referencia.
- **Ojo:** si el video no tiene subtítulos, recurre a una **API** de Whisper que pide llave y cuesta dinero. Mejor usa el whisper.cpp local de la plantilla.
- **Instalar:** viene en el marketplace del proyecto, o `/plugin marketplace add bradautomates/claude-video` y `/plugin install watch@claude-video`.
- **Licencia:** MIT (Copyright 2026 Bradley Bonanno).

## Skills de Emil Kowalski (animación)

- **Qué son:** `emil-design-eng` (pulido de interfaz y decisiones de animación), `animate` (arma una animación eligiendo curva, duración y propiedades), `review-animations` (revisión estricta; se llama a mano), `improve-animations` (audita un código y planea arreglos), `animation-vocabulary` (le pone nombre al efecto que traes en la cabeza). El repo trae más, como `animation-performance` y `apple-design`.
- **Para este editor:** curvas y tiempos para el pop de las tarjetas, la entrada de los stickers y el motion flotante. Sus valores están pensados para interfaces web; pásalos a cuadros (30 fps).
- **Instalar:** `npx skills@latest add emilkowalski/skills` (no es un marketplace de plugins de Claude Code, por eso no está en `marketplaces.json`).
- **Licencia:** MIT (Copyright 2026 Emil Kowalski), en el `LICENSE` del repo. Los `SKILL.md` sueltos no traen encabezado de licencia. No se incluye aquí; se instala desde su autor.

## Motion Architect

- **Qué es:** un agente de Claude Code para motion graphics con Remotion: estudia tus referencias, arma tu marca, escribe un storyboard que apruebas, anima y renderiza en vertical, horizontal, cuadrado o 4:5. Versión del plugin: 0.2.0. Su instalador solo soporta macOS y Linux.
- **Instalar (según su README):** `git clone https://github.com/Hainrixz/motion-architect.git` y luego `./install.sh`. Su manifiesto declara el marketplace `motion-architect` con el plugin `motion-architect`, así que `/plugin marketplace add Hainrixz/motion-architect` y `/plugin install motion-architect@motion-architect` deberían funcionar.
- **Estado: sin verificar.** El 2026-10-11 el repo de GitHub respondió 404 a peticiones anónimas (privado o sin publicar), por eso no está en `marketplaces.json`. Agrégalo cuando sea público.
- **Licencia:** MIT, según su `LICENSE` y su `plugin.json`. Renderiza con Remotion, así que aplica la licencia de Remotion.

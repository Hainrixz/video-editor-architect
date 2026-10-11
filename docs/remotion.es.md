# Remotion en esta plantilla

[English](remotion.md)

Revisado el 2026-10-11. Fuentes en [fuentes-investigacion.md](fuentes-investigacion.md).

## Qué hace Remotion aquí

Claude escribe cada edición como un JSON (`proyectos/<slug>/edicion-vN.json`, la EDL). Remotion es el motor que la dibuja: una composición de React llamada "Reel" lee la EDL y acomoda el video base, los subtítulos, el titular, las tarjetas, los stickers, los inserts y el sonido, cuadro por cuadro. `herramientas/render.ts` llama a `selectComposition` y `renderMedia` de Remotion para sacar `salida/final-vN.mp4`. Con Remotion Studio ves la edición antes de renderizar.

La plantilla fija Remotion en **4.0.532** (`package.json`). La versión estable más nueva en npm el 2026-10-11 era **4.0.534**. Actualiza a propósito y lleva todos los paquetes `@remotion/*` a la misma versión (la skill `remotion-upgrade` te ayuda).

## Aviso de licencia (léelo)

Remotion **no** es código abierto con MIT ni Apache. Tiene su propia licencia (`LICENSE.md` en `remotion-dev/remotion`, "Copyright © 2026 Remotion"; la empresa detrás es Remotion AG).

**Licencia gratuita.** Puedes usar Remotion gratis, incluso para ganar dinero, si eres:

- una persona,
- una empresa o equipo con **hasta 3 personas**,
- una organización sin fines de lucro,
- o alguien que lo está evaluando y todavía no lo usa de forma comercial.

**Licencia de empresa (Company License).** Las organizaciones de **4 personas o más** (y las colaboraciones de ese tamaño) tienen que comprarla en remotion.pro/license. Precios públicos al 2026-10-11:

- **Remotion for Creators:** 25 dólares al mes por asiento, para quien hace videos para su organización a mano o con agentes de IA y Remotion Studio.
- **Remotion for Automators:** 0.01 dólares por render con un mínimo de 100 dólares al mes, para automatizaciones y productos de video.
- Gasto mínimo combinado: 100 dólares al mes. **Enterprise** empieza en 500 dólares al mes.

**Por qué te importa con esta plantilla.** El FAQ de Remotion llama "automatización" a tener código que llama a `renderMedia()` (entre otras) o a `npx remotion render`. El `render.ts` de esta plantilla llama a `renderMedia()`. Si estás en una organización de 4 personas o más, confirma con Remotion si te toca Creators, Automators o los dos. Esto está **sin verificar** para este caso en concreto; pregúntale a Remotion (su FAQ de licencia trae un correo de contacto). Con la licencia gratuita no pagas por render.

Usar esta plantilla no te da una licencia de Remotion. Cada persona o empresa que la clona responde por la suya.

## Requisitos por sistema

Lo que pide Remotion (documentación, 2026-10-11): Node 16+ o Bun 1.0.3+. Esta plantilla necesita **Node 24+** (`package.json` → `engines`).

- **macOS:** **macOS 15 (Sequoia) o más nuevo**; las versiones anteriores no tienen soporte.
- **Windows:** solo **x64** (según la guía de migración a v4.0). El navegador de render existe para Windows x64.
- **Linux (y WSL2):** glibc 2.35 o más nueva y unos paquetes extra que lista Remotion en su página de dependencias de Linux. Alpine y NixOS no tienen soporte.

**Chrome Headless Shell.** Remotion lo baja solo a `node_modules/.remotion/chrome-headless-shell/<plataforma>/` la primera vez que renderiza (macOS x64/arm64, Windows x64, Linux x64/arm64). Puedes bajarlo antes con `npx remotion browser ensure`. No funciona dentro del sandbox de Claude Code en macOS; por eso los comandos de render están en `excludedCommands`.

**FFmpeg.** Remotion 4 trae su propio FFmpeg chico (la documentación de la CLI dice que es de la línea 7.1; la guía de migración a v4.0 todavía dice 6.0) y FFprobe dentro de `@remotion/renderer`, y los llamas con `npx remotion ffmpeg` y `npx remotion ffprobe`. Solo entiende los códecs que usa Remotion (H.264, H.265, VP8, VP9, ProRes). Las demás herramientas de la plantilla (ingesta, cortes, video base, loudness, QA) llaman al `ffmpeg` y `ffprobe` **del sistema**, así que igual tienes que instalarlos: lee [instalar-macos.es.md](instalar-macos.es.md) e [instalar-windows.es.md](instalar-windows.es.md).

## Skills de Remotion para agentes

Remotion publica skills oficiales para agentes (`npx skills add remotion-dev/skills`). No vienen en este repo. Lee [habilidades.es.md](habilidades.es.md).

# Estilos de edición / Editing styles

Cada estilo vive en su carpeta `estilo/estilos/<id>/` (id en minúsculas con guiones). / Each style lives in its own folder.

| Archivo | Qué guarda |
|---|---|
| `perfil.md` | Reglas vigentes, lo que NO va, números de referencia (cada uno con su n y su fuente) e historial de entrenamiento con las frases literales del creador y su fecha. |
| `perfil.json` | Los mismos valores para el código. La sección `motor` es la que lee el motor (`herramientas/lib/perfil-estilo.ts` → `leerPerfilMotor()`): `velocidad`, `aires`, `zona`, `ritmo` y `decisiones`. Lo que no trae sale del motor neutro. |
| `aprendizajes.md` | Lo técnico que se aprendió entrenándolo: qué funcionó, qué no y cuánto costó. |
| `fuentes.json` | De dónde salió: sus propios reels o los perfiles y videos de referencia que él nombró, y "lo que le gusta" tal cual lo dijo. |

El registro está en `estilos.json`: id, nombre, carpeta, estado y reel de referencia. Estados:

- `base`: estilo genérico de arranque (`base-neutra`). Sirve para editar sin entrenar.
- `en-prueba`: se está entrenando.
- `aprobado`: el creador dijo que sí. `/editar` lo ofrece primero.
- `descartado`: no se ofrece al editar; la carpeta se queda como historial.

El estilo activo es `creador.json` → `estilo_activo`. Para empezar uno nuevo, copia `_plantilla/`.

## El perfil manda

El perfil manda sobre el borrador del director y sobre lo que diga `/editar` cuando choquen. Son decisiones del creador; lo medido de sus reels (`estilo/estilo.json`) es la base y el perfil va encima.

## Al editar

- Si el creador nombra el estilo, se usa ese.
- Si no lo nombra, Claude pregunta cuál antes de dirigir (los de `estilos.json`, los aprobados primero, más "entrenar uno nuevo"), aunque solo haya uno.
- El elegido se anota en `proyectos/<slug>/notas-director.json` → `"estilo": "<id>"`, y cada versión renderizada dice con qué estilo salió.

## Cómo se entrena

- **De sus propios reels publicados:** `/aprender-estilo` (corpus de `creador.json` → `corpus`; yt-dlp o carpeta de mp4 gratis, Apify con costo dicho y su sí).
- **De creadores que él nombre:** `/entrenar-estilo` (perfiles y videos de referencia, lo que le gusta).

En los dos casos el ciclo es el mismo: **referencias → lo que le gusta → perfil `en-prueba` → prueba en un crudo → sus correcciones → `aprobado`**.

## Cómo se versiona

- Cada corrección va **literal y con fecha** al historial de `perfil.md`, y se ajusta la regla y `perfil.json`. El historial no se borra.
- Al aprobar un final, se agrega como reel de referencia con su versión y sus números (con n), y se sube `version` en `perfil.json` y en `estilos.json`.
- Las ediciones de prueba van en el mismo proyecto como `edicion-vN.json` nuevas: nunca se pisa una versión de otro estilo.
- Todo esto va en git, en el repo privado del creador.

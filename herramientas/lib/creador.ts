/**
 * Quién es el creador: `creador.json` en la raíz del repo (en la plantilla viene `creador.example.json` para copiarlo).
 * Es lo único personal que necesita el motor: nombre, handle, idioma, estilo activo, de dónde sale el corpus de sus
 * reels publicados y qué fuentes de SFX acepta.
 *
 * Si no existe, el motor usa valores neutros y no falla: nombre y handle vacíos, español, ningún estilo activo
 * (perfil-estilo.ts usa MOTOR_NEUTRO), corpus vacío y todas las fuentes de SFX. Lo que de verdad necesita el handle
 * (armar el corpus, emparejar crudos con reels) lo pide con `requerirHandle` (código 2: "llena creador.json").
 * Si existe pero está mal, sale con código 2.
 *
 * Las rutas se guardan tal cual (con `~`); `expandirRuta` las vuelve absolutas con os.homedir().
 */
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {fallo} from './fallo.ts';

/** Raíz del repo (dos carpetas arriba de este archivo). */
export const RAIZ_CREADOR = fileURLToPath(new URL('../../', import.meta.url));
export const ARCHIVO_CREADOR = 'creador.json';

const Rutas = z.array(z.string().min(1)).default([]);

export const CorpusCreadorEsquema = z.looseObject({
	/** Id numérico de la cuenta (Apify: ownerId; yt-dlp: uploader_id). null = solo se compara el handle. */
	instagram_id: z.string().min(1).nullable().default(null),
	/** Carpetas con JSON de Apify de la cuenta (perfil con latestPosts, reels-*.json…). */
	carpetas_apify: Rutas,
	/**
	 * Carpetas de un descargador con yt-dlp. Cada una con `data/videos/<shortCode>.mp4` + `.info.json`, y opcionales
	 * `data/raw/*.json` (JSON crudos de Apify) y `data/state.db` (solo para explicar por qué falta un mp4).
	 */
	carpetas_ytdlp: Rutas,
	/** Carpetas extra con `fuentes/instagram-reels-<handle>-*.json` y `videos/ig_0*_<shortCode>.mp4`. */
	carpetas_extra: Rutas,
	/** Carpetas donde están los crudos (videos sin editar) para emparejarlos con sus reels publicados. */
	crudos: Rutas,
});

export const SfxCreadorEsquema = z.looseObject({
	/** Fuentes de SFX que se pueden usar (biblioteca/sfx/catalogo.json → fuente). Vacío = todas. */
	solo_fuentes: z.array(z.string().min(1)).default([]),
	/** Carpeta de SFX de Pixabay para sfx/catalogar.ts (opcional; --pixabay manda). */
	pixabay: z.string().min(1).nullable().default(null),
});

export const CreadorEsquema = z.looseObject({
	version: z.literal(1).default(1),
	nombre: z.string().default(''),
	/** Handle sin @ (se compara sin mayúsculas). */
	handle: z
		.string()
		.default('')
		.transform((h) => h.trim().replace(/^@/, '')),
	plataforma: z.string().min(1).default('instagram'),
	idioma: z.enum(['es', 'en']).default('es'),
	/** Id del estilo (estilo/estilos/<id>/perfil.json) que usa el motor. null = MOTOR_NEUTRO. */
	estilo_activo: z.string().min(1).nullable().default(null),
	corpus: CorpusCreadorEsquema.default({instagram_id: null, carpetas_apify: [], carpetas_ytdlp: [], carpetas_extra: [], crudos: []}),
	sfx: SfxCreadorEsquema.default({solo_fuentes: [], pixabay: null}),
	/** Opcional: archivo de la voz del creador (lista "Prohibido" para revisar el titular). */
	voz: z.string().min(1).nullable().default(null),
	/** Opcional: modelo de whisper para emparejar.ts (EDITOR_WHISPER_MODELO manda). */
	whisper_modelo: z.string().min(1).nullable().default(null),
});

export type Creador = z.infer<typeof CreadorEsquema>;

/** El creador neutro: lo que usa el motor si no hay creador.json. */
export const CREADOR_NEUTRO: Creador = CreadorEsquema.parse({});

/** `~` y `~/x` → ruta absoluta en el home; lo relativo se resuelve contra `base` (la raíz por defecto). */
export function expandirRuta(p: string, base: string = RAIZ_CREADOR): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/')) return join(homedir(), p.slice(2));
	return isAbsolute(p) ? p : resolve(base, p);
}

export const rutaCreador = (raiz: string = RAIZ_CREADOR): string => join(raiz, ARCHIVO_CREADOR);

/**
 * Lee creador.json de la raíz (o de `opciones.raiz`). Sin archivo: CREADOR_NEUTRO. Con un archivo que no es JSON o no
 * cumple la forma: código 2.
 */
export function leerCreador(opciones: {raiz?: string} = {}): Creador {
	const ruta = rutaCreador(opciones.raiz);
	if (!existsSync(ruta)) return structuredClone(CREADOR_NEUTRO);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer creador.json', `${ARCHIVO_CREADOR} no es JSON válido`, 'corrígelo (copia creador.example.json si lo necesitas)', 2);
	}
	const r = CreadorEsquema.safeParse(datos);
	if (!r.success) {
		const detalle = r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
		throw fallo('leer creador.json', `${ARCHIVO_CREADOR} no cumple la forma (${detalle})`, 'corrígelo con creador.example.json como guía', 2, r.error.issues);
	}
	return r.data;
}

/** ¿Hay creador.json en la raíz? */
export const hayCreador = (opciones: {raiz?: string} = {}): boolean => existsSync(rutaCreador(opciones.raiz));

/** El handle del creador o un fallo con código 2 que pide llenar creador.json (para `que` se hace). */
export function requerirHandle(creador: Creador, que: string): string {
	if (!creador.handle) {
		throw fallo(que, 'creador.json no dice de quién son los reels (falta "handle")', 'copia creador.example.json a creador.json y llena tu handle y tus carpetas del corpus', 2);
	}
	return creador.handle;
}

/** Fuentes de SFX permitidas: null = todas (lista vacía o sin creador.json). */
export const fuentesSfxDe = (creador: Creador): string[] | null => (creador.sfx.solo_fuentes.length > 0 ? [...creador.sfx.solo_fuentes] : null);

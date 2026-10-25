// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * corpus.ts: el corpus de los reels publicados del creador (Fase 2). Une tus fuentes por shortCode filtrando por dueño, se
 * queda con la captura más reciente de cada reel, arma el ranking por puntaje y, con --muestra, elige la muestra
 * estratificada con la que se mide tu estilo. Con --bajar intenta traer (sin cookies) los mp4 del top 10 que no
 * estén en local.
 *
 *   npx tsx herramientas/estilo/corpus.ts [--muestra] [--bajar]
 *
 * Fuentes (solo lectura: nada se mueve, se copia ni se borra). Las carpetas salen de creador.json → corpus (se usa
 * la primera de cada lista):
 *   - carpetas_apify: <carpeta>/*.json (Apify; de perfil.json, sus latestPosts).
 *   - carpetas_ytdlp: <carpeta>/data/raw/*.json (Apify) y data/videos/*.info.json (yt-dlp) con sus .mp4.
 *   - carpetas_extra: SOLO fuentes/instagram-reels-<handle>-*.json y videos/ig_0*.mp4. Lo demás de esa carpeta
 *     (comp_*, los JSON de otras cuentas) no se abre.
 *   - referencias/reels/<shortCode>.mp4 (+ .info.json): lo que bajó --bajar.
 *   - Diagnóstico, solo para explicar por qué falta un mp4: <carpeta yt-dlp>/data/state.db en solo lectura.
 *     De ahí no sale ninguna métrica.
 *
 * Reglas:
 *   - Dueño: creador.json → handle (ownerUsername) e instagram_id (ownerId; en yt-dlp, channel / uploader_id). Sin
 *     handle sale con código 2 ("llena creador.json"). Lo que no trae dueño, o trae otro, no entra. Un mp4 solo entra si su shortCode ya es tuyo según una fuente con dueño.
 *   - Captura: cada archivo es una captura con su fecha: `capturado_en` del archivo; si no trae, la fecha del nombre
 *     afinada con la hora de modificación; si tampoco, la hora de modificación; en yt-dlp, `epoch`.
 *   - Métricas: plays, likes y comments salen JUNTOS de la captura más reciente del reel que traiga plays y likes,
 *     para no mezclar momentos (yt-dlp no trae plays). `videoViewCount` NO cuenta como plays: es otra métrica
 *     (en apify/posts-100, views/plays: mediana 0.313, p10 0.030, p90 0.365, n=99). Con yt-dlp más nuevo, los likes
 *     suben en mediana 11.7 % (p90 40.9 %, n=310) contra la captura con plays: mezclarlos inflaría el puntaje.
 *     latestComments, URLs firmadas y demás campos pesados se descartan.
 *   - Puntaje = promedio(plays / mediana de plays, likes / mediana de likes), con las medianas de los reels del
 *     ranking. Fuera del ranking: sin plays o likes, o con menos de 14 días entre su publicación y su captura.
 *   - Muestra: 10 del top histórico, 10 recientes (jun–sep 2026, mp4 1440×2560) que no estén ya y 5 debajo de la
 *     mediana de puntaje ("resto"), sin los pares crudo↔reel aceptados de pruebas/pares.json. Recientes y resto se
 *     reparten parejo en el tiempo (cuantiles por fecha) para no cargarse a una sola semana; los recientes con
 *     puntaje van primero.
 *
 * Salidas: estilo/corpus.json (siempre) y estilo/muestra.json (con --muestra). Corre dentro del sandbox; --bajar
 * necesita red hacia instagram.com y deja su bitácora en referencias/reels/_intentos.json.
 * Códigos: 0 bien (aunque una bajada falle: queda anotada) · 1 fallo interno · 2 falta una fuente o un dato tuyo.
 * No gasta nada: ni Apify, ni Gemini, ni cookies.
 */
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {expandirRuta, leerCreador, requerirHandle, type Creador} from '../lib/creador.ts';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {sondear} from '../lib/ffprobe.ts';
import {RAIZ} from '../lib/manifest.ts';

// ───────────────────────────── constantes ─────────────────────────────

/** De quién son los reels: handle (sin @, minúsculas) e id numérico de la cuenta (null = solo se compara el handle). */
export type Dueno = {username: string; id: string | null};

/** El dueño según creador.json (código 2 si no trae handle). */
export function duenoDe(creador: Creador): Dueno {
	return {username: requerirHandle(creador, 'armar el corpus').toLowerCase(), id: creador.corpus.instagram_id};
}
let duenoLeido: Dueno | null = null;
/** El dueño de creador.json, leído una vez por proceso. */
export const duenoActivo = (): Dueno => (duenoLeido ??= duenoDe(leerCreador()));
/** Un reel con menos días que esto entre su publicación y su captura no entra al ranking. */
export const DIAS_MINIMOS = 14;
/** Largo máximo del caption guardado (en caracteres visibles). */
export const LARGO_CAPTION = 160;
export const PATRON_SHORTCODE = /^[A-Za-z0-9_-]{5,20}$/;
const escaparRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** De la carpeta extra solo se abren los JSON del dueño y estos mp4 (lo demás es de otras cuentas). */
export const patronJsonExtra = (username: string): RegExp => new RegExp(`^instagram-reels-${escaparRe(username)}-.*\\.json$`, 'i');
export const PATRON_MP4_MATRIZ = /^ig_0\d*_([A-Za-z0-9_-]+)\.mp4$/;
/** Un mp4 es incompleto si dura menos que el reel publicado menos max(1 s, 3 %). */
export const TOLERANCIA_DURACION_S = 1;
export const TOLERANCIA_DURACION_REL = 0.03;

export const MUESTRA_POR_DEFECTO = {
	nTop: 10,
	nRecientes: 10,
	nResto: 5,
	/** Ventana de "recientes" en UTC: [desde, hasta). */
	recientesDesde: '2026-06-01T00:00:00.000Z',
	recientesHasta: '2026-10-01T00:00:00.000Z',
	resolucionRecientes: '1440x2560',
} as const;

const HOME = homedir();

export type RutasFuentes = {
	/** Carpeta con los JSON de Apify de tu cuenta. */
	apify: string;
	/** Carpeta con los JSON crudos de Apify que guardó insta-youtube. */
	instaRaw: string;
	/** Carpeta con <shortCode>.mp4 y <shortCode>.info.json (yt-dlp) de insta-youtube. */
	instaVideos: string;
	/** Carpeta fuentes/ de matriz-viral (solo se abre tu JSON). */
	matrizFuentes: string;
	/** Carpeta videos/ de matriz-viral (solo ig_0*.mp4). */
	matrizVideos: string;
	/** referencias/reels del editor: lo que baja --bajar. */
	referencias: string;
	/** Base de datos del descargador (solo para explicar por qué falta un mp4). */
	db?: string | null;
};

/** Una carpeta que no existe: lo que no dice creador.json se lista vacío (y queda como fuente que falta). */
const SIN_CARPETA = join(RAIZ, '.sin-carpeta-en-creador-json');

/** Las rutas de las fuentes según creador.json → corpus (la primera carpeta de cada lista). */
export function rutasDe(creador: Creador): RutasFuentes {
	const primera = (l: readonly string[]): string | null => (l[0] ? expandirRuta(l[0]) : null);
	const apify = primera(creador.corpus.carpetas_apify);
	const ytdlp = primera(creador.corpus.carpetas_ytdlp);
	const extra = primera(creador.corpus.carpetas_extra);
	return {
		apify: apify ?? SIN_CARPETA,
		instaRaw: ytdlp ? join(ytdlp, 'data', 'raw') : SIN_CARPETA,
		instaVideos: ytdlp ? join(ytdlp, 'data', 'videos') : SIN_CARPETA,
		matrizFuentes: extra ? join(extra, 'fuentes') : SIN_CARPETA,
		matrizVideos: extra ? join(extra, 'videos') : SIN_CARPETA,
		referencias: join(RAIZ, 'referencias', 'reels'),
		db: ytdlp ? join(ytdlp, 'data', 'state.db') : null,
	};
}

export const RUTA_PARES = join(RAIZ, 'pruebas', 'pares.json');
export const SALIDA_CORPUS = join(RAIZ, 'estilo', 'corpus.json');
export const SALIDA_MUESTRA = join(RAIZ, 'estilo', 'muestra.json');
export const YT_DLP = '/opt/homebrew/bin/yt-dlp';
export const ARCHIVO_INTENTOS = '_intentos.json';

// ───────────────────────────── tipos ─────────────────────────────

/** De dónde salió la fecha de una captura. */
export type OrigenFecha = 'archivo' | 'nombre+mtime' | 'nombre' | 'mtime' | 'epoch';

/** Lo que una fuente dice de un reel en un momento dado. */
export type Captura = {
	shortCode: string;
	/** Etiqueta corta de la fuente, p. ej. "apify/reels-200" o "insta-youtube/raw/pagination-2026-09-29". */
	fuente: string;
	capturado_en: string;
	origen_fecha: OrigenFecha;
	publicado_en: string | null;
	duracion_s: number | null;
	plays: number | null;
	likes: number | null;
	comments: number | null;
	caption: string | null;
};

export type FuenteMp4 = 'insta-youtube/mp4' | 'referencias/mp4' | 'matriz-viral/mp4';
/** Con la misma resolución, se prefiere el mp4 en este orden. */
export const ORDEN_FUENTE_MP4: readonly FuenteMp4[] = ['insta-youtube/mp4', 'referencias/mp4', 'matriz-viral/mp4'];

export type Mp4Local = {
	shortCode: string;
	ruta: string;
	fuente: FuenteMp4;
	ancho: number | null;
	alto: number | null;
	fps: number | null;
	duracion_s: number | null;
	/** Si ffprobe no lo pudo leer, el motivo en una línea. */
	error: string | null;
};

export type SondeoMp4 = {ancho: number; alto: number; fps: number; duracion_s: number};
export type Sondeador = (ruta: string) => Promise<SondeoMp4>;

export type ResumenFuente = {
	fuente: string;
	ruta: string;
	tipo: 'apify' | 'yt-dlp' | 'mp4';
	archivos: number;
	capturado_en: string | null;
	/** Para fuentes de muchos archivos (yt-dlp): la captura más vieja y la más nueva. */
	capturado_desde: string | null;
	capturado_hasta: string | null;
	origen_fecha: OrigenFecha | 'varios' | null;
	items: number;
	del_dueno: number;
	otra_cuenta: number;
	cuentas_descartadas: string[];
	no_es_video: number;
	invalidos: number;
	ilegibles: string[];
	/** La carpeta o el archivo no existe. */
	falta: boolean;
};

export type DescarteMp4 = {ruta: string; motivo: string};

export type Recoleccion = {
	capturas: Captura[];
	mp4s: Mp4Local[];
	fuentes: ResumenFuente[];
	mp4_descartados: DescarteMp4[];
};

export type ReelCorpus = {
	shortCode: string;
	publicado_en: string | null;
	duracion_s: number | null;
	plays: number | null;
	likes: number | null;
	comments: number | null;
	caption: string | null;
	/** Fecha de la captura de donde salen plays, likes y comments. */
	capturado_en: string | null;
	fuente_metricas: string | null;
	edad_dias_en_captura: number | null;
	/** "ANCHOxALTO" del mp4 local elegido (ya rotado), o null. */
	resolucion: string | null;
	fps: number | null;
	mp4: string | null;
	mp4_fuente: FuenteMp4 | null;
	mp4_duracion_s: number | null;
	/** El mp4 dura bastante menos que el reel publicado (se queda, pero no entra a recientes ni resto). */
	mp4_incompleto: boolean;
	/** Todas las fuentes donde aparece el reel (JSON y mp4). */
	fuentes: string[];
	n_capturas: number;
	puntaje: number | null;
	rank: number | null;
	fuera_de_ranking: string | null;
};

export type Ranking = {
	reels: ReelCorpus[];
	mediana_plays: number;
	mediana_likes: number;
	mediana_puntaje: number;
	n: number;
};

export type GrupoMuestra = 'top' | 'recientes' | 'resto';

export type MiembroMuestra = {
	grupo: GrupoMuestra;
	shortCode: string;
	puntaje: number | null;
	rank: number | null;
	mp4: string | null;
	resolucion: string | null;
	fps: number | null;
	duracion_s: number | null;
	publicado_en: string | null;
	plays: number | null;
	likes: number | null;
	nota: string | null;
};

export type OpcionesMuestra = {
	excluir: ReadonlySet<string>;
	nTop: number;
	nRecientes: number;
	nResto: number;
	recientesDesde: string;
	recientesHasta: string;
	resolucionRecientes: string;
	medianaPuntaje: number;
};

export type Muestra = {
	miembros: MiembroMuestra[];
	n: Record<GrupoMuestra, number> & {total: number};
	candidatos: {recientes: number; recientes_con_puntaje: number; resto: number};
};

export type Intento = {
	shortCode: string;
	intentado_en: string;
	ok: boolean;
	/** El error de yt-dlp en una línea, o null si bajó. */
	error: string | null;
	archivo: string | null;
};

// ───────────────────────────── utilidades puras ─────────────────────────────

type Objeto = Record<string, unknown>;
const esObjeto = (x: unknown): x is Objeto => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Conteo válido (≥ 0) o null. Apify pone −1 cuando los likes están ocultos. */
export function conteo(x: unknown): number | null {
	return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
}

/** Número > 0 redondeado a 3 decimales (las duraciones de Apify traen ruido de float: 89.25599670410156). */
function positivo(x: unknown): number | null {
	return typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x * 1000) / 1000 : null;
}

/** Texto de fecha (ISO de Apify) → ISO UTC normalizado, o null. */
export function isoDeTexto(x: unknown): string | null {
	if (typeof x !== 'string' || x.trim() === '') return null;
	const ms = Date.parse(x);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Segundos desde 1970 (yt-dlp) → ISO UTC, o null. */
export function isoDeEpoch(x: unknown): string | null {
	if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) return null;
	return new Date(x * 1000).toISOString();
}

const GRAFEMAS = new Intl.Segmenter('es', {granularity: 'grapheme'});

/** Caption en una línea y recortado a `largo` caracteres visibles (grafemas: no parte emojis compuestos). */
export function recortarCaption(texto: unknown, largo = LARGO_CAPTION): string | null {
	if (typeof texto !== 'string') return null;
	const limpio = texto.replace(/\s+/g, ' ').trim();
	if (!limpio) return null;
	const letras = Array.from(GRAFEMAS.segment(limpio), (s) => s.segment);
	if (letras.length <= largo) return limpio;
	return `${letras.slice(0, largo - 1).join('').trimEnd()}…`;
}

/** Etiqueta de una cuenta descartada: "usuario/id", lo que traiga, o "sin dueño". */
function etiquetaCuenta(usuario: unknown, id: unknown): string {
	const partes = [usuario, id].filter((x) => (typeof x === 'string' && x.trim() !== '') || typeof x === 'number').map(String);
	return partes.length > 0 ? partes.join('/') : 'sin dueño';
}

/**
 * ¿Es del dueño? Si el item trae usuario o id de dueño, todos los que trae deben ser los suyos; si no trae ninguno,
 * no entra (un item sin dueño no se puede atribuir). Si creador.json no trae instagram_id, un item con solo id no entra.
 */
export function esDelDueno(usuario: unknown, id: unknown, dueno: Dueno = duenoActivo()): boolean {
	const tieneUsuario = typeof usuario === 'string' && usuario.trim() !== '';
	const tieneId = (typeof id === 'string' && id.trim() !== '') || (typeof id === 'number' && Number.isFinite(id));
	if (!tieneUsuario && !tieneId) return false;
	if (!tieneUsuario && dueno.id === null) return false;
	if (tieneUsuario && (usuario as string).trim().toLowerCase() !== dueno.username) return false;
	if (tieneId && dueno.id !== null && String(id).trim() !== dueno.id) return false;
	return true;
}

/** Los items de un JSON de Apify: un arreglo de posts, `{items: [...]}` (matriz-viral) o perfiles con latestPosts. */
export function itemsDeJson(datos: unknown): unknown[] {
	const base = Array.isArray(datos) ? datos : esObjeto(datos) && Array.isArray(datos.items) ? datos.items : [];
	const items: unknown[] = [];
	for (const x of base) {
		if (esObjeto(x) && x.shortCode === undefined && Array.isArray(x.latestPosts)) items.push(...x.latestPosts);
		else items.push(x);
	}
	return items;
}

/**
 * Fecha de captura de un archivo: su `capturado_en` si lo trae; si el nombre trae fecha (AAAA-MM-DD, la de UTC con
 * la que lo nombró el scraper), la hora de modificación cuando cae ese mismo día (si no, el inicio del día); si no
 * hay nada de eso, la hora de modificación.
 */
export function fechaDeCaptura(nombre: string, mtime: Date, contenido?: unknown): {capturado_en: string; origen_fecha: OrigenFecha} {
	if (esObjeto(contenido)) {
		const iso = isoDeTexto(contenido.capturado_en);
		if (iso) return {capturado_en: iso, origen_fecha: 'archivo'};
	}
	const m = /(\d{4})-(\d{2})-(\d{2})/.exec(nombre);
	if (m) {
		const dia = `${m[1]}-${m[2]}-${m[3]}`;
		const inicio = isoDeTexto(`${dia}T00:00:00.000Z`);
		if (inicio && inicio.slice(0, 10) === dia) {
			if (mtime.toISOString().slice(0, 10) === dia) return {capturado_en: mtime.toISOString(), origen_fecha: 'nombre+mtime'};
			return {capturado_en: inicio, origen_fecha: 'nombre'};
		}
	}
	return {capturado_en: mtime.toISOString(), origen_fecha: 'mtime'};
}

export type MetaCaptura = {fuente: string; capturado_en: string; origen_fecha: OrigenFecha};
export type Descartes = {otra_cuenta: number; no_es_video: number; invalidos: number; cuentas: string[]};

/** Convierte los items de Apify en capturas tuyas; cuenta lo que no entra y de qué cuentas era. */
export function capturasDeApify(items: readonly unknown[], meta: MetaCaptura, dueno: Dueno = duenoActivo()): {capturas: Captura[]; descartes: Descartes} {
	const capturas: Captura[] = [];
	const cuentas = new Set<string>();
	const descartes: Descartes = {otra_cuenta: 0, no_es_video: 0, invalidos: 0, cuentas: []};
	for (const item of items) {
		if (!esObjeto(item) || typeof item.shortCode !== 'string' || !PATRON_SHORTCODE.test(item.shortCode)) {
			descartes.invalidos++;
			continue;
		}
		if (!esDelDueno(item.ownerUsername, item.ownerId, dueno)) {
			descartes.otra_cuenta++;
			cuentas.add(etiquetaCuenta(item.ownerUsername, item.ownerId));
			continue;
		}
		// Solo reels: un post de imagen o carrusel no es un reel.
		if (item.type !== undefined && item.type !== 'Video' && item.productType !== 'clips') {
			descartes.no_es_video++;
			continue;
		}
		capturas.push({
			shortCode: item.shortCode,
			fuente: meta.fuente,
			capturado_en: meta.capturado_en,
			origen_fecha: meta.origen_fecha,
			publicado_en: isoDeTexto(item.timestamp),
			duracion_s: positivo(item.videoDuration),
			plays: conteo(item.videoPlayCount),
			likes: conteo(item.likesCount),
			comments: conteo(item.commentsCount),
			caption: recortarCaption(item.caption),
		});
	}
	descartes.cuentas = [...cuentas].sort();
	return {capturas, descartes};
}

/**
 * Convierte el .info.json de yt-dlp en una captura (sin plays: el extractor de Instagram no los trae).
 * Devuelve el motivo si no entra.
 */
export function capturaDeInfoYtdlp(
	info: unknown,
	fuente: string,
	mtime: Date,
	dueno: Dueno = duenoActivo(),
): {captura: Captura; motivo: null} | {captura: null; motivo: 'invalido' | 'otra_cuenta' | 'no_es_video'; cuenta?: string} {
	if (!esObjeto(info)) return {captura: null, motivo: 'invalido'};
	const sc = [info.id, info.display_id, info.webpage_url_basename].find(
		(x): x is string => typeof x === 'string' && PATRON_SHORTCODE.test(x),
	);
	if (!sc) return {captura: null, motivo: 'invalido'};
	if (!esDelDueno(info.channel, info.uploader_id, dueno)) {
		return {captura: null, motivo: 'otra_cuenta', cuenta: etiquetaCuenta(info.channel, info.uploader_id)};
	}
	if (info._type !== undefined && info._type !== 'video') return {captura: null, motivo: 'no_es_video'};
	const epoch = isoDeEpoch(info.epoch);
	return {
		captura: {
			shortCode: sc,
			fuente,
			capturado_en: epoch ?? mtime.toISOString(),
			origen_fecha: epoch ? 'epoch' : 'mtime',
			publicado_en: isoDeEpoch(info.timestamp),
			duracion_s: positivo(info.duration),
			plays: null,
			likes: conteo(info.like_count),
			comments: conteo(info.comment_count),
			caption: recortarCaption(info.description),
		},
		motivo: null,
	};
}

/** shortCode de un mp4 según su carpeta; null si el nombre no es de un reel tuyo (p. ej. comp_*). */
export function shortCodeDeMp4(nombre: string, carpeta: 'insta-youtube' | 'matriz-viral' | 'referencias'): string | null {
	if (/^comp_/i.test(nombre)) return null;
	const m = carpeta === 'matriz-viral' ? PATRON_MP4_MATRIZ.exec(nombre) : /^([A-Za-z0-9_-]+)\.mp4$/.exec(nombre);
	return m && PATRON_SHORTCODE.test(m[1]) ? m[1] : null;
}

/** Orden de capturas: la más reciente primero; empate → más plays, más likes, fuente (para que sea determinista). */
export function compararCapturas(a: Captura, b: Captura): number {
	const t = Date.parse(b.capturado_en) - Date.parse(a.capturado_en);
	if (t !== 0) return t;
	const p = (b.plays ?? -1) - (a.plays ?? -1);
	if (p !== 0) return p;
	const l = (b.likes ?? -1) - (a.likes ?? -1);
	if (l !== 0) return l;
	return a.fuente < b.fuente ? -1 : a.fuente > b.fuente ? 1 : 0;
}

/**
 * La captura de la que salen las métricas: la más reciente que trae plays Y likes. Si ninguna trae las dos, la
 * más reciente con alguna; si ninguna trae métricas, la más reciente a secas.
 */
export function elegirCapturaMetricas(capturas: readonly Captura[]): Captura | null {
	if (capturas.length === 0) return null;
	const orden = [...capturas].sort(compararCapturas);
	return (
		orden.find((c) => c.plays !== null && c.likes !== null) ??
		orden.find((c) => c.plays !== null || c.likes !== null) ??
		orden[0]
	);
}

/** ¿El mp4 dura bastante menos que el reel publicado? */
export function esIncompleto(duracionMp4: number | null, duracionReel: number | null): boolean {
	if (duracionMp4 === null || duracionReel === null) return false;
	return duracionMp4 < duracionReel - Math.max(TOLERANCIA_DURACION_S, TOLERANCIA_DURACION_REL * duracionReel);
}

/** El mp4 que se usa: legible, completo si hay alguno, de más resolución y, a igual resolución, por fuente. */
export function elegirMp4(mp4s: readonly Mp4Local[], duracionReel: number | null): {mp4: Mp4Local; incompleto: boolean} | null {
	const legibles = mp4s.filter((m) => m.error === null && m.ancho !== null && m.alto !== null);
	if (legibles.length === 0) return null;
	const orden = [...legibles].sort((a, b) => {
		const ia = esIncompleto(a.duracion_s, duracionReel) ? 1 : 0;
		const ib = esIncompleto(b.duracion_s, duracionReel) ? 1 : 0;
		if (ia !== ib) return ia - ib;
		const px = (b.ancho ?? 0) * (b.alto ?? 0) - (a.ancho ?? 0) * (a.alto ?? 0);
		if (px !== 0) return px;
		const f = ORDEN_FUENTE_MP4.indexOf(a.fuente) - ORDEN_FUENTE_MP4.indexOf(b.fuente);
		if (f !== 0) return f;
		return a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0;
	});
	return {mp4: orden[0], incompleto: esIncompleto(orden[0].duracion_s, duracionReel)};
}

const redondear = (x: number, decimales: number): number => {
	const f = 10 ** decimales;
	return Math.round(x * f) / f;
};

/** Días entre la publicación y la captura. */
export function edadDias(publicado: string | null, capturado: string | null): number | null {
	if (!publicado || !capturado) return null;
	const d = (Date.parse(capturado) - Date.parse(publicado)) / 86_400_000;
	return Number.isFinite(d) ? d : null;
}

/** Une capturas y mp4s por shortCode. Solo entran los shortCodes con al menos una captura tuya. */
export function construirReels(capturas: readonly Captura[], mp4s: readonly Mp4Local[]): ReelCorpus[] {
	const porReel = new Map<string, Captura[]>();
	for (const c of capturas) {
		const lista = porReel.get(c.shortCode);
		if (lista) lista.push(c);
		else porReel.set(c.shortCode, [c]);
	}
	const mp4PorReel = new Map<string, Mp4Local[]>();
	for (const m of mp4s) {
		if (!porReel.has(m.shortCode)) continue;
		const lista = mp4PorReel.get(m.shortCode);
		if (lista) lista.push(m);
		else mp4PorReel.set(m.shortCode, [m]);
	}

	const reels: ReelCorpus[] = [];
	for (const [shortCode, lista] of porReel) {
		const orden = [...lista].sort(compararCapturas);
		const metricas = elegirCapturaMetricas(orden);
		const conValor = <K extends keyof Captura>(k: K): Captura[K] | null => {
			const c = orden.find((x) => x[k] !== null);
			return c ? c[k] : null;
		};
		const publicado_en = metricas?.publicado_en ?? conValor('publicado_en');
		const duracionDeclarada = conValor('duracion_s');
		const mp4sReel = mp4PorReel.get(shortCode) ?? [];
		const elegido = elegirMp4(mp4sReel, duracionDeclarada);
		const fuentes = new Set<string>(lista.map((c) => c.fuente));
		for (const m of mp4sReel) fuentes.add(m.fuente);
		const edad = edadDias(publicado_en, metricas?.capturado_en ?? null);
		reels.push({
			shortCode,
			publicado_en,
			duracion_s: duracionDeclarada ?? (elegido ? elegido.mp4.duracion_s : null),
			plays: metricas?.plays ?? null,
			likes: metricas?.likes ?? null,
			comments: metricas?.comments ?? null,
			caption: conValor('caption'),
			capturado_en: metricas?.capturado_en ?? null,
			fuente_metricas: metricas?.fuente ?? null,
			edad_dias_en_captura: edad === null ? null : redondear(edad, 2),
			resolucion: elegido ? `${elegido.mp4.ancho}x${elegido.mp4.alto}` : null,
			fps: elegido?.mp4.fps ?? null,
			mp4: elegido?.mp4.ruta ?? null,
			mp4_fuente: elegido?.mp4.fuente ?? null,
			mp4_duracion_s: elegido?.mp4.duracion_s ?? null,
			mp4_incompleto: elegido?.incompleto ?? false,
			fuentes: [...fuentes].sort(),
			n_capturas: lista.length,
			puntaje: null,
			rank: null,
			fuera_de_ranking: null,
		});
	}
	// Del más nuevo al más viejo; sin fecha, al final.
	return reels.sort((a, b) => (b.publicado_en ?? '').localeCompare(a.publicado_en ?? '') || a.shortCode.localeCompare(b.shortCode));
}

/** Mediana clásica (con número par, el promedio de los dos de en medio). NaN si no hay valores. */
export function mediana(valores: readonly number[]): number {
	if (valores.length === 0) return Number.NaN;
	const o = [...valores].sort((a, b) => a - b);
	const m = Math.floor(o.length / 2);
	return o.length % 2 === 1 ? o[m] : (o[m - 1] + o[m]) / 2;
}

/** Por qué un reel no entra al ranking, o null si entra. */
export function motivoFueraDeRanking(r: Pick<ReelCorpus, 'plays' | 'likes' | 'publicado_en' | 'capturado_en'>, dias = DIAS_MINIMOS): string | null {
	if (r.plays === null) return 'sin plays en ninguna captura';
	if (r.likes === null) return 'sin likes en su captura';
	if (r.publicado_en === null) return 'sin fecha de publicación';
	const edad = edadDias(r.publicado_en, r.capturado_en);
	if (edad === null) return 'sin fecha de captura';
	if (edad < dias) return `menos de ${dias} días al capturarse (${edad.toFixed(1)} d)`;
	return null;
}

/** Puntaje = promedio(plays / mediana de plays, likes / mediana de likes). */
export function puntaje(plays: number, likes: number, medianaPlays: number, medianaLikes: number): number {
	return (plays / medianaPlays + likes / medianaLikes) / 2;
}

/**
 * Ranking: medianas de plays y likes sobre los reels que entran (≥ `dias` días al capturarse, con plays y likes),
 * puntaje y lugar (empates: más plays, luego shortCode). Los que no entran quedan con puntaje null y su motivo.
 */
export function rankear(reels: readonly ReelCorpus[], dias = DIAS_MINIMOS): Ranking {
	const motivos = new Map(reels.map((r) => [r.shortCode, motivoFueraDeRanking(r, dias)]));
	const elegibles = reels.filter((r) => motivos.get(r.shortCode) === null);
	if (elegibles.length === 0) {
		throw fallo(
			'armar el ranking',
			`ningún reel tiene plays y likes con ${dias} días o más al capturarse`,
			'revisa que tus JSON de Apify sigan en las carpetas de creador.json → corpus',
			2,
		);
	}
	const medianaPlays = mediana(elegibles.map((r) => r.plays as number));
	const medianaLikes = mediana(elegibles.map((r) => r.likes as number));
	if (!(medianaPlays > 0) || !(medianaLikes > 0)) {
		throw fallo(
			'armar el ranking',
			`la mediana de plays (${medianaPlays}) o de likes (${medianaLikes}) es 0 y el puntaje no se puede calcular`,
			'revisa que las capturas traigan videoPlayCount y likesCount',
			2,
		);
	}
	const puntajes = new Map<string, number>();
	for (const r of elegibles) puntajes.set(r.shortCode, puntaje(r.plays as number, r.likes as number, medianaPlays, medianaLikes));
	const orden = [...elegibles].sort(
		(a, b) =>
			(puntajes.get(b.shortCode) as number) - (puntajes.get(a.shortCode) as number) ||
			(b.plays as number) - (a.plays as number) ||
			a.shortCode.localeCompare(b.shortCode),
	);
	const lugar = new Map(orden.map((r, i) => [r.shortCode, i + 1]));
	const salida = reels.map((r) => {
		const p = puntajes.get(r.shortCode);
		return {
			...r,
			puntaje: p === undefined ? null : redondear(p, 4),
			rank: lugar.get(r.shortCode) ?? null,
			fuera_de_ranking: motivos.get(r.shortCode) ?? null,
		};
	});
	return {
		reels: salida,
		mediana_plays: medianaPlays,
		mediana_likes: medianaLikes,
		mediana_puntaje: redondear(mediana([...puntajes.values()]), 4),
		n: elegibles.length,
	};
}

/** Toma `n` elementos repartidos parejo a lo largo de la lista (cuantiles centrados). Sin repetidos. */
export function repartirParejo<T>(lista: readonly T[], n: number): T[] {
	if (n <= 0) return [];
	if (lista.length <= n) return [...lista];
	const elegidos: T[] = [];
	for (let i = 0; i < n; i++) elegidos.push(lista[Math.floor(((i + 0.5) * lista.length) / n)]);
	return elegidos;
}

const porFecha = (a: ReelCorpus, b: ReelCorpus): number =>
	(a.publicado_en ?? '').localeCompare(b.publicado_en ?? '') || a.shortCode.localeCompare(b.shortCode);

/** ¿El mp4 sirve para medir? (existe, se leyó y está completo) */
const mp4Util = (r: ReelCorpus): boolean => r.mp4 !== null && !r.mp4_incompleto;

/**
 * Muestra estratificada: top (los primeros del ranking), recientes (en la ventana, con mp4 en la resolución pedida,
 * repartidos parejo por fecha; primero los que tienen puntaje) y resto (puntaje debajo de la mediana, con mp4,
 * repartidos parejo por fecha). Sin repetidos y sin los reels de `excluir`.
 */
export function elegirMuestra(reels: readonly ReelCorpus[], opciones: OpcionesMuestra): Muestra {
	const usados = new Set<string>();
	const disponible = (r: ReelCorpus) => !opciones.excluir.has(r.shortCode) && !usados.has(r.shortCode);
	const miembros: MiembroMuestra[] = [];
	const agregar = (grupo: GrupoMuestra, r: ReelCorpus, nota: string | null) => {
		usados.add(r.shortCode);
		miembros.push({
			grupo,
			shortCode: r.shortCode,
			puntaje: r.puntaje,
			rank: r.rank,
			mp4: r.mp4,
			resolucion: r.resolucion,
			fps: r.fps,
			duracion_s: r.duracion_s,
			publicado_en: r.publicado_en,
			plays: r.plays,
			likes: r.likes,
			nota,
		});
	};

	// 1) Top histórico: tal cual el ranking, tenga o no mp4 (si falta, queda anotado).
	const top = reels
		.filter((r) => r.rank !== null && disponible(r))
		.sort((a, b) => (a.rank as number) - (b.rank as number))
		.slice(0, opciones.nTop);
	for (const r of top) {
		const nota = r.mp4 === null ? 'sin mp4 local' : r.mp4_incompleto ? 'mp4 incompleto' : null;
		agregar('top', r, nota);
	}

	// 2) Recientes: ventana [desde, hasta), mp4 en la resolución pedida, repartidos parejo por fecha.
	const desde = Date.parse(opciones.recientesDesde);
	const hasta = Date.parse(opciones.recientesHasta);
	const enVentana = (r: ReelCorpus) => {
		const t = r.publicado_en ? Date.parse(r.publicado_en) : Number.NaN;
		return t >= desde && t < hasta;
	};
	const candidatosRecientes = reels
		.filter((r) => disponible(r) && enVentana(r) && mp4Util(r) && r.resolucion === opciones.resolucionRecientes)
		.sort(porFecha);
	const conPuntaje = candidatosRecientes.filter((r) => r.puntaje !== null);
	const sinPuntaje = candidatosRecientes.filter((r) => r.puntaje === null);
	const recientes =
		conPuntaje.length >= opciones.nRecientes
			? repartirParejo(conPuntaje, opciones.nRecientes)
			: [...conPuntaje, ...repartirParejo(sinPuntaje, opciones.nRecientes - conPuntaje.length)].sort(porFecha);
	for (const r of recientes) agregar('recientes', r, r.puntaje === null ? `sin puntaje: ${r.fuera_de_ranking ?? 'fuera del ranking'}` : null);

	// 3) Resto: puntaje debajo de la mediana, con mp4, repartidos parejo por fecha.
	const candidatosResto = reels
		.filter((r) => disponible(r) && r.puntaje !== null && r.puntaje < opciones.medianaPuntaje && mp4Util(r))
		.sort(porFecha);
	for (const r of repartirParejo(candidatosResto, opciones.nResto)) agregar('resto', r, null);

	const cuenta = (g: GrupoMuestra) => miembros.filter((m) => m.grupo === g).length;
	return {
		miembros,
		n: {top: cuenta('top'), recientes: cuenta('recientes'), resto: cuenta('resto'), total: miembros.length},
		candidatos: {recientes: candidatosRecientes.length, recientes_con_puntaje: conPuntaje.length, resto: candidatosResto.length},
	};
}

/** Los shortCodes de los pares crudo↔reel ACEPTADOS de pruebas/pares.json (los reels de prueba). */
export function shortCodesDePares(datos: unknown): string[] {
	if (!Array.isArray(datos)) return [];
	const codigos = new Set<string>();
	for (const p of datos) {
		if (esObjeto(p) && p.aceptado === true && typeof p.shortCode === 'string') codigos.add(p.shortCode);
	}
	return [...codigos].sort();
}

/**
 * Candado final: nada de comp_*, nada fuera de las carpetas permitidas y nada repetido. Si algo se coló, es un bug:
 * se corta con código 1 antes de escribir.
 */
export function validarCorpus(reels: readonly ReelCorpus[], rutas: RutasFuentes = rutasDe(leerCreador())): void {
	const vistos = new Set<string>();
	const carpetasMp4 = [rutas.instaVideos, rutas.matrizVideos, rutas.referencias];
	for (const r of reels) {
		if (vistos.has(r.shortCode)) throw fallo('validar el corpus', `el reel ${r.shortCode} aparece dos veces`, 'avísame: es un bug de corpus.ts', 1);
		vistos.add(r.shortCode);
		if (r.fuentes.some((f) => /comp_/i.test(f))) {
			throw fallo('validar el corpus', `el reel ${r.shortCode} trae una fuente comp_* (de otra cuenta)`, 'avísame: es un bug de corpus.ts', 1);
		}
		if (r.mp4 !== null) {
			const nombre = basename(r.mp4);
			const enCarpeta = carpetasMp4.some((c) => relative(c, r.mp4 as string) === nombre);
			if (/^comp_/i.test(nombre) || !enCarpeta) {
				throw fallo('validar el corpus', `el mp4 de ${r.shortCode} (${r.mp4}) no es de una carpeta de reels tuyos`, 'avísame: es un bug de corpus.ts', 1);
			}
			if (r.mp4.startsWith(rutas.matrizVideos) && !PATRON_MP4_MATRIZ.test(nombre)) {
				throw fallo('validar el corpus', `el mp4 de ${r.shortCode} en matriz-viral no es un ig_0*`, 'avísame: es un bug de corpus.ts', 1);
			}
		}
	}
}

/** La última línea útil del stderr de yt-dlp (la de "ERROR:" si la hay), recortada a una línea. */
export function lineaDeError(stderr: string): string {
	const lineas = stderr
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.filter((l) => l.length > 0);
	const error = [...lineas].reverse().find((l) => l.startsWith('ERROR:'));
	const linea = error ?? lineas[lineas.length - 1] ?? 'yt-dlp falló sin decir por qué';
	return linea.length > 400 ? `${linea.slice(0, 399)}…` : linea;
}

/** Argumentos de yt-dlp para bajar un reel SIN cookies (ni de archivo ni del navegador) y sin leer configs. */
export function argumentosYtDlp(shortCode: string, carpeta: string): string[] {
	if (!PATRON_SHORTCODE.test(shortCode)) {
		throw fallo('preparar la bajada', `"${shortCode}" no parece un shortCode de Instagram`, 'revisa el corpus', 1);
	}
	return [
		'--ignore-config',
		'--no-cookies',
		'--no-cookies-from-browser',
		'--no-cache-dir',
		'--no-playlist',
		'--no-progress',
		'--socket-timeout',
		'30',
		'--retries',
		'2',
		'-f',
		'bv*+ba/b',
		'--merge-output-format',
		'mp4',
		'--write-info-json',
		'-o',
		join(carpeta, `${shortCode}.%(ext)s`),
		`https://www.instagram.com/reel/${shortCode}/`,
	];
}

/** Une la bitácora vieja con los intentos nuevos: queda el último intento de cada reel. */
export function unirIntentos(viejos: readonly Intento[], nuevos: readonly Intento[]): Intento[] {
	const porReel = new Map<string, Intento>();
	for (const i of [...viejos, ...nuevos]) {
		const previo = porReel.get(i.shortCode);
		if (!previo || Date.parse(i.intentado_en) >= Date.parse(previo.intentado_en)) porReel.set(i.shortCode, i);
	}
	return [...porReel.values()].sort((a, b) => a.shortCode.localeCompare(b.shortCode));
}

/** Por qué insta-youtube no tiene el mp4, según su fila en state.db (diagnóstico, no métrica). */
export function textoMotivoInsta(fila: {cand: number | null; motivo: string | null; bajado: number} | undefined): string {
	if (!fila) return 'insta-youtube no lo tiene en su base';
	if (fila.cand === null) return 'insta-youtube no lo evaluó como candidato y por eso nunca lo bajó';
	if (fila.cand === 0) return `insta-youtube lo descartó como candidato (${fila.motivo ?? 'sin motivo'}) y por eso no lo bajó`;
	if (!fila.bajado) return 'insta-youtube lo marcó como candidato pero todavía no lo baja';
	return 'insta-youtube dice que lo bajó, pero el mp4 no está en data/videos';
}

// ───────────────────────────── lectura de disco ─────────────────────────────

const existeCarpeta = (ruta: string): boolean => {
	try {
		return statSync(ruta).isDirectory();
	} catch {
		return false;
	}
};

const listar = (carpeta: string, filtro: (nombre: string) => boolean): string[] =>
	existeCarpeta(carpeta)
		? readdirSync(carpeta)
				.filter((n) => !n.startsWith('.') && filtro(n))
				.sort()
		: [];

function resumenVacio(fuente: string, ruta: string, tipo: ResumenFuente['tipo']): ResumenFuente {
	return {
		fuente,
		ruta,
		tipo,
		archivos: 0,
		capturado_en: null,
		capturado_desde: null,
		capturado_hasta: null,
		origen_fecha: null,
		items: 0,
		del_dueno: 0,
		otra_cuenta: 0,
		cuentas_descartadas: [],
		no_es_video: 0,
		invalidos: 0,
		ilegibles: [],
		falta: false,
	};
}

/** Lee un JSON de Apify (un archivo = una captura) y devuelve sus capturas tuyas con el resumen de la fuente. */
function leerJsonApify(ruta: string, fuente: string, dueno: Dueno): {capturas: Captura[]; resumen: ResumenFuente} {
	const resumen = resumenVacio(fuente, ruta, 'apify');
	resumen.archivos = 1;
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		resumen.ilegibles.push(`${basename(ruta)}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
		return {capturas: [], resumen};
	}
	const fecha = fechaDeCaptura(basename(ruta), statSync(ruta).mtime, datos);
	const items = itemsDeJson(datos);
	const {capturas, descartes} = capturasDeApify(items, {fuente, ...fecha}, dueno);
	Object.assign(resumen, {
		capturado_en: fecha.capturado_en,
		origen_fecha: fecha.origen_fecha,
		items: items.length,
		del_dueno: capturas.length,
		otra_cuenta: descartes.otra_cuenta,
		cuentas_descartadas: descartes.cuentas,
		no_es_video: descartes.no_es_video,
		invalidos: descartes.invalidos,
	});
	return {capturas, resumen};
}

/** Lee los .info.json de yt-dlp de una carpeta (una captura por archivo). */
function leerInfosYtdlp(carpeta: string, fuente: string, dueno: Dueno): {capturas: Captura[]; resumen: ResumenFuente} {
	const resumen = resumenVacio(fuente, carpeta, 'yt-dlp');
	resumen.falta = !existeCarpeta(carpeta);
	const capturas: Captura[] = [];
	const cuentas = new Set<string>();
	for (const nombre of listar(carpeta, (n) => n.endsWith('.info.json') && !/^comp_/i.test(n))) {
		const ruta = join(carpeta, nombre);
		resumen.archivos++;
		resumen.items++;
		let info: unknown;
		try {
			info = JSON.parse(readFileSync(ruta, 'utf8'));
		} catch (error) {
			resumen.ilegibles.push(`${nombre}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
			continue;
		}
		const r = capturaDeInfoYtdlp(info, fuente, statSync(ruta).mtime, dueno);
		if (r.captura) {
			capturas.push(r.captura);
			resumen.del_dueno++;
		} else if (r.motivo === 'otra_cuenta') {
			resumen.otra_cuenta++;
			if (r.cuenta) cuentas.add(r.cuenta);
		} else if (r.motivo === 'no_es_video') resumen.no_es_video++;
		else resumen.invalidos++;
	}
	resumen.cuentas_descartadas = [...cuentas].sort();
	if (capturas.length > 0) {
		const fechas = capturas.map((c) => c.capturado_en).sort();
		resumen.capturado_desde = fechas[0];
		resumen.capturado_hasta = fechas[fechas.length - 1];
		const origenes = new Set(capturas.map((c) => c.origen_fecha));
		resumen.origen_fecha = origenes.size === 1 ? [...origenes][0] : 'varios';
	}
	return {capturas, resumen};
}

/** Sondea un mp4 con ffprobe: tamaño ya rotado, fps reales y duración. */
export async function sondearMp4(ruta: string): Promise<SondeoMp4> {
	const s = await sondear(ruta);
	return {ancho: s.video.anchoVisible, alto: s.video.altoVisible, fps: redondear(s.video.fpsReal, 3), duracion_s: redondear(s.duracion, 3)};
}

async function enParalelo<T, R>(items: readonly T[], limite: number, fn: (x: T) => Promise<R>): Promise<R[]> {
	const salida: R[] = new Array(items.length);
	let siguiente = 0;
	const trabajador = async () => {
		while (siguiente < items.length) {
			const i = siguiente++;
			salida[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({length: Math.min(limite, items.length)}, trabajador));
	return salida;
}

/**
 * Recolecta todas las capturas y los mp4 locales. Los mp4 se sondean con `sondeador` (ffprobe por defecto; las
 * pruebas pasan uno falso). Un mp4 cuyo shortCode no es tuyo por ninguna fuente con dueño queda descartado.
 */
export async function recolectar(rutas: RutasFuentes = rutasDe(leerCreador()), sondeador: Sondeador = sondearMp4, dueno: Dueno = duenoActivo()): Promise<Recoleccion> {
	const capturas: Captura[] = [];
	const fuentes: ResumenFuente[] = [];
	const agregar = (r: {capturas: Captura[]; resumen: ResumenFuente}) => {
		capturas.push(...r.capturas);
		fuentes.push(r.resumen);
	};

	// 1) Apify de tu cuenta (todos los *.json de la carpeta).
	const jsonApify = listar(rutas.apify, (n) => n.endsWith('.json'));
	if (jsonApify.length === 0) fuentes.push({...resumenVacio('apify', rutas.apify, 'apify'), falta: true});
	for (const nombre of jsonApify) agregar(leerJsonApify(join(rutas.apify, nombre), `apify/${basename(nombre, '.json')}`, dueno));

	// 2) insta-youtube: JSON crudos de Apify y .info.json de yt-dlp.
	const jsonRaw = listar(rutas.instaRaw, (n) => n.endsWith('.json'));
	if (jsonRaw.length === 0) fuentes.push({...resumenVacio('insta-youtube/raw', rutas.instaRaw, 'apify'), falta: true});
	for (const nombre of jsonRaw) agregar(leerJsonApify(join(rutas.instaRaw, nombre), `insta-youtube/raw/${basename(nombre, '.json')}`, dueno));
	agregar(leerInfosYtdlp(rutas.instaVideos, 'insta-youtube/info', dueno));

	// 3) carpeta extra: SOLO el JSON del dueño (instagram-reels-<handle>-*.json).
	const patronMatriz = patronJsonExtra(dueno.username);
	const jsonMatriz = listar(rutas.matrizFuentes, (n) => patronMatriz.test(n));
	if (jsonMatriz.length === 0) fuentes.push({...resumenVacio('matriz-viral', rutas.matrizFuentes, 'apify'), falta: true});
	for (const nombre of jsonMatriz) {
		const etiqueta = basename(nombre, '.json').replace(new RegExp(`^instagram-reels-${escaparRe(dueno.username)}-`, 'i'), '');
		agregar(leerJsonApify(join(rutas.matrizFuentes, nombre), `matriz-viral/${etiqueta}`, dueno));
	}

	// 4) Lo que bajó --bajar (yt-dlp).
	if (existeCarpeta(rutas.referencias)) agregar(leerInfosYtdlp(rutas.referencias, 'referencias/info', dueno));

	if (capturas.length === 0) {
		throw fallo(
			'armar el corpus',
			'no encontré ninguna captura tuya en APIFY, insta-youtube ni matriz-viral',
			'revisa que las carpetas de creador.json → corpus sigan en su lugar',
			2,
		);
	}

	// 5) mp4 locales: solo de reels tuyos (por shortCode) y nunca comp_*.
	const tuyos = new Set(capturas.map((c) => c.shortCode));
	const mp4_descartados: DescarteMp4[] = [];
	const candidatos: {shortCode: string; ruta: string; fuente: FuenteMp4}[] = [];
	const carpetas: {carpeta: string; tipo: 'insta-youtube' | 'matriz-viral' | 'referencias'; fuente: FuenteMp4}[] = [
		{carpeta: rutas.instaVideos, tipo: 'insta-youtube', fuente: 'insta-youtube/mp4'},
		{carpeta: rutas.matrizVideos, tipo: 'matriz-viral', fuente: 'matriz-viral/mp4'},
		{carpeta: rutas.referencias, tipo: 'referencias', fuente: 'referencias/mp4'},
	];
	for (const {carpeta, tipo, fuente} of carpetas) {
		const resumen = resumenVacio(fuente, carpeta, 'mp4');
		resumen.falta = !existeCarpeta(carpeta);
		// En matriz-viral ni se listan los comp_*: solo los ig_0*.
		const nombres = listar(carpeta, (n) => n.toLowerCase().endsWith('.mp4') && (tipo !== 'matriz-viral' || PATRON_MP4_MATRIZ.test(n)));
		for (const nombre of nombres) {
			resumen.items++;
			const ruta = join(carpeta, nombre);
			const sc = shortCodeDeMp4(nombre, tipo);
			if (!sc) {
				resumen.invalidos++;
				mp4_descartados.push({ruta, motivo: 'el nombre no es <shortCode>.mp4 de un reel tuyo'});
				continue;
			}
			if (!tuyos.has(sc)) {
				resumen.otra_cuenta++;
				mp4_descartados.push({ruta, motivo: 'su shortCode no aparece en ninguna fuente con tu cuenta como dueña'});
				continue;
			}
			resumen.del_dueno++;
			candidatos.push({shortCode: sc, ruta, fuente});
		}
		resumen.archivos = resumen.items;
		fuentes.push(resumen);
	}
	const mp4s = await enParalelo(candidatos, 8, async (c): Promise<Mp4Local> => {
		try {
			const s = await sondeador(c.ruta);
			return {...c, ancho: s.ancho, alto: s.alto, fps: s.fps, duracion_s: s.duracion_s, error: null};
		} catch (error) {
			const motivo = error instanceof Error ? error.message.split('\n')[0] : String(error);
			return {...c, ancho: null, alto: null, fps: null, duracion_s: null, error: motivo};
		}
	});
	for (const m of mp4s) if (m.error) mp4_descartados.push({ruta: m.ruta, motivo: `ffprobe no lo pudo leer: ${m.error}`});
	return {capturas, mp4s, fuentes, mp4_descartados};
}

function leerJsonOpcional(ruta: string): unknown {
	try {
		return JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		return null;
	}
}

/** Lee la bitácora de bajadas (referencias/reels/_intentos.json); vacía si no existe. */
export function leerIntentos(carpeta: string): Intento[] {
	const datos = leerJsonOpcional(join(carpeta, ARCHIVO_INTENTOS));
	if (!Array.isArray(datos)) return [];
	return datos.filter(
		(i): i is Intento => esObjeto(i) && typeof i.shortCode === 'string' && typeof i.intentado_en === 'string' && typeof i.ok === 'boolean',
	);
}

/** Corre yt-dlp para un reel. Nunca lanza: devuelve el intento con su error en una línea. */
export function bajarReel(shortCode: string, carpeta: string, binario = YT_DLP): Promise<Intento> {
	const intentado_en = new Date().toISOString();
	const destino = join(carpeta, `${shortCode}.mp4`);
	return new Promise((resolver) => {
		let args: string[];
		try {
			args = argumentosYtDlp(shortCode, carpeta);
		} catch (error) {
			resolver({shortCode, intentado_en, ok: false, error: error instanceof Error ? error.message : String(error), archivo: null});
			return;
		}
		mkdirSync(carpeta, {recursive: true});
		execFile(binario, args, {timeout: 180_000, maxBuffer: 16 * 1024 * 1024}, (error, _stdout, stderr) => {
			if (!error && existsSync(destino)) {
				resolver({shortCode, intentado_en, ok: true, error: null, archivo: destino});
				return;
			}
			const e = error as (NodeJS.ErrnoException & {killed?: boolean}) | null;
			let motivo: string;
			if (e?.code === 'ENOENT') motivo = `no encuentro yt-dlp en ${binario}`;
			else if (e?.killed) motivo = 'yt-dlp tardó más de 3 min y lo detuve';
			else if (!error) motivo = `yt-dlp terminó sin error pero no dejó ${basename(destino)}`;
			else motivo = lineaDeError(String(stderr ?? '')) || e?.message || 'yt-dlp falló';
			resolver({shortCode, intentado_en, ok: false, error: motivo, archivo: null});
		});
	});
}

/** Motivos de insta-youtube (state.db en solo lectura) para los reels sin mp4. Si algo falla, devuelve vacío. */
export async function motivosInstaYoutube(rutaDb: string, shortCodes: readonly string[]): Promise<Map<string, string>> {
	const motivos = new Map<string, string>();
	if (shortCodes.length === 0 || !existsSync(rutaDb)) return motivos;
	try {
		const {DatabaseSync} = await import('node:sqlite');
		const db = new DatabaseSync(rutaDb, {readOnly: true});
		try {
			const consulta = db.prepare(
				`SELECT c.is_candidate AS cand, c.reject_reason AS motivo,
					EXISTS(SELECT 1 FROM assets a WHERE a.short_code = r.short_code) AS bajado
				FROM reels r LEFT JOIN candidates c ON c.short_code = r.short_code WHERE r.short_code = ?`,
			);
			for (const sc of shortCodes) {
				const fila = consulta.get(sc) as {cand: number | null; motivo: string | null; bajado: number} | undefined;
				motivos.set(sc, textoMotivoInsta(fila));
			}
		} finally {
			db.close();
		}
	} catch {
		// Es solo un diagnóstico: si la base no abre (bloqueada, otro esquema), el corpus sigue sin él.
	}
	return motivos;
}

// ───────────────────────────── salida ─────────────────────────────

const ETIQUETA_RUTA = (ruta: string): string => ruta.replace(HOME, '~');

/** Texto de por qué falta el mp4 de un reel del top. */
export function textoFalta(motivoInsta: string | undefined, intento: Intento | undefined): string {
	const partes = ['no está en insta-youtube/data/videos, matriz-viral/videos (ig_0*) ni referencias/reels'];
	if (motivoInsta) partes.push(motivoInsta);
	if (intento && !intento.ok) partes.push(`yt-dlp sin cookies (${intento.intentado_en.slice(0, 10)}): ${intento.error}`);
	else if (!intento) partes.push('yt-dlp: no se ha intentado (corre con --bajar)');
	return partes.join('; ');
}

function contar<T>(lista: readonly T[], clave: (x: T) => string | null): Record<string, number> {
	const c: Record<string, number> = {};
	for (const x of lista) {
		const k = clave(x);
		if (k !== null) c[k] = (c[k] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export type ArmadoCorpus = {
	reels: ReelCorpus[];
	ranking: Ranking;
	recoleccion: Recoleccion;
};

/** Recolecta, une y rankea (sin escribir nada). */
export async function armarCorpus(rutas: RutasFuentes = rutasDe(leerCreador()), sondeador: Sondeador = sondearMp4, dias = DIAS_MINIMOS, dueno: Dueno = duenoActivo()): Promise<ArmadoCorpus> {
	const recoleccion = await recolectar(rutas, sondeador, dueno);
	const reels = construirReels(recoleccion.capturas, recoleccion.mp4s);
	const ranking = rankear(reels, dias);
	validarCorpus(ranking.reels, rutas);
	return {reels: ranking.reels, ranking, recoleccion};
}

function escribirJson(ruta: string, datos: unknown): void {
	mkdirSync(dirname(ruta), {recursive: true});
	writeFileSync(ruta, `${JSON.stringify(datos, null, '\t')}\n`);
}

const miles = (n: number): string => n.toLocaleString('es-MX');

async function main(): Promise<void> {
	let values: {muestra: boolean; bajar: boolean};
	try {
		({values} = parseArgs({
			options: {muestra: {type: 'boolean', default: false}, bajar: {type: 'boolean', default: false}},
			allowPositionals: false,
		}));
	} catch (error) {
		const motivo = error instanceof Error ? error.message.split('\n')[0] : String(error);
		throw fallo('leer las opciones', `no las entiendo (${motivo})`, 'usa: npx tsx herramientas/estilo/corpus.ts [--muestra] [--bajar]', 2);
	}

	const creador = leerCreador();
	const dueno = duenoDe(creador);
	const RUTAS = rutasDe(creador);
	let armado = await armarCorpus(RUTAS, sondearMp4, DIAS_MINIMOS, dueno);
	const top10 = () => armado.reels.filter((r) => r.rank !== null && r.rank <= 10).sort((a, b) => (a.rank as number) - (b.rank as number));

	// Bajadas de los del top 10 sin mp4 (sin cookies). Se anotan en la bitácora aunque fallen.
	let intentos = leerIntentos(RUTAS.referencias);
	if (values.bajar) {
		const faltan = top10().filter((r) => r.mp4 === null || r.mp4_incompleto);
		if (faltan.length === 0) console.log('Bajadas: el top 10 ya tiene todos sus mp4 en local; no bajo nada.');
		const nuevos: Intento[] = [];
		for (const r of faltan) {
			console.log(`Bajando ${r.shortCode} con yt-dlp (sin cookies)…`);
			const intento = await bajarReel(r.shortCode, RUTAS.referencias);
			console.log(intento.ok ? `  bajó: ${ETIQUETA_RUTA(intento.archivo as string)}` : `  no bajó: ${intento.error}`);
			nuevos.push(intento);
		}
		if (nuevos.length > 0) {
			intentos = unirIntentos(intentos, nuevos);
			escribirJson(join(RUTAS.referencias, ARCHIVO_INTENTOS), intentos);
			if (nuevos.some((i) => i.ok)) armado = await armarCorpus(RUTAS, sondearMp4, DIAS_MINIMOS, dueno);
		}
	}

	const {reels, ranking, recoleccion} = armado;
	const intentoDe = new Map(intentos.map((i) => [i.shortCode, i]));
	const sinMp4Top = top10().filter((r) => r.mp4 === null);
	const motivosInsta = await motivosInstaYoutube(RUTAS.db ?? SIN_CARPETA, sinMp4Top.map((r) => r.shortCode));

	const conMp4 = reels.filter((r) => r.mp4 !== null);
	const resumen = {
		reels: reels.length,
		con_plays_y_likes: reels.filter((r) => r.plays !== null && r.likes !== null).length,
		con_plays: reels.filter((r) => r.plays !== null).length,
		con_likes: reels.filter((r) => r.likes !== null).length,
		con_mp4: conMp4.length,
		mp4_incompletos: conMp4.filter((r) => r.mp4_incompleto).length,
		mp4_por_resolucion: contar(conMp4, (r) => r.resolucion),
		mp4_por_fuente: contar(conMp4, (r) => r.mp4_fuente),
		fps_por_resolucion: contar(conMp4, (r) => `${r.resolucion} @ ${r.fps === null ? '?' : Math.round(r.fps)} fps`),
		mp4_archivos_tuyos: recoleccion.mp4s.length,
		mp4_descartados: recoleccion.mp4_descartados.length,
		publicados_desde: reels.map((r) => r.publicado_en).filter((x): x is string => x !== null).sort()[0] ?? null,
		publicados_hasta: reels.map((r) => r.publicado_en).filter((x): x is string => x !== null).sort().pop() ?? null,
		de_otra_cuenta_descartados: recoleccion.fuentes.reduce((s, f) => s + f.otra_cuenta, 0),
		en_ranking: ranking.n,
		fuera_de_ranking: contar(reels, (r) => (r.fuera_de_ranking ? r.fuera_de_ranking.replace(/ \(.*\)$/, '') : null)),
	};

	const top = top10().map((r) => ({
		rank: r.rank,
		shortCode: r.shortCode,
		puntaje: r.puntaje,
		plays: r.plays,
		likes: r.likes,
		publicado_en: r.publicado_en,
		mp4: r.mp4,
		resolucion: r.resolucion,
		mp4_fuente: r.mp4_fuente,
		falta: r.mp4 === null ? textoFalta(motivosInsta.get(r.shortCode), intentoDe.get(r.shortCode)) : null,
	}));

	const corpus = {
		version: 1,
		generado_en: new Date().toISOString(),
		generado_por: 'herramientas/estilo/corpus.ts',
		dueno,
		reglas: {
			dueno: `ownerUsername ${dueno.username}${dueno.id ? ` / ownerId ${dueno.id}` : ''} (yt-dlp: channel / uploader_id); sin dueño o de otro, no entra; un mp4 solo entra si su shortCode es tuyo por alguna fuente con dueño`,
			matriz_viral: `solo fuentes/instagram-reels-${dueno.username}-*.json y videos/ig_0*.mp4; los videos de competidores y los JSON de otras cuentas no se abren`,
			captura: 'plays, likes y comments salen juntos de la captura más reciente que traiga plays y likes (yt-dlp no trae plays; videoViewCount no cuenta como plays); los comentarios y las URLs firmadas se descartan',
			fecha_captura: 'capturado_en del archivo; si no, la fecha del nombre afinada con la hora de modificación; si no, la hora de modificación; yt-dlp: epoch',
			mp4: 'el de más resolución entre los legibles y completos; a igual resolución, insta-youtube > referencias > matriz-viral; incompleto = dura menos que el reel − max(1 s, 3 %)',
		},
		fuentes: recoleccion.fuentes.map((f) => ({...f, ruta: ETIQUETA_RUTA(f.ruta)})),
		resumen,
		ranking: {
			criterio: 'puntaje = promedio(plays / mediana de plays, likes / mediana de likes); medianas sobre los reels del ranking',
			dias_minimos: DIAS_MINIMOS,
			n: ranking.n,
			mediana_plays: ranking.mediana_plays,
			mediana_likes: ranking.mediana_likes,
			mediana_puntaje: ranking.mediana_puntaje,
		},
		top10: top,
		bajadas: intentos,
		mp4_descartados: recoleccion.mp4_descartados.map((d) => ({...d, ruta: ETIQUETA_RUTA(d.ruta)})),
		reels,
	};
	escribirJson(SALIDA_CORPUS, corpus);

	// Resumen en la terminal.
	const res = Object.entries(resumen.mp4_por_resolucion)
		.map(([k, v]) => `${v} en ${k.replace('x', '×')}`)
		.join(', ');
	console.log(
		`Corpus: ${resumen.reels} reels tuyos (${resumen.de_otra_cuenta_descartados} items de otra cuenta descartados, 0 comp_*), ` +
			`${resumen.con_plays_y_likes} con plays y likes; ${resumen.con_mp4} con mp4 local (${res}).`,
	);
	console.log(
		`Ranking: ${ranking.n} reels (fuera: ${Object.entries(resumen.fuera_de_ranking)
			.map(([k, v]) => `${v} ${k}`)
			.join(', ')}). Medianas: plays ${miles(ranking.mediana_plays)}, likes ${miles(ranking.mediana_likes)}.`,
	);
	console.log('Top 10 histórico:');
	for (const t of top) {
		const donde = t.mp4 ? `${t.resolucion} (${t.mp4_fuente})` : `SIN mp4: ${t.falta}`;
		console.log(`  ${String(t.rank).padStart(2)}. ${t.shortCode}  puntaje ${t.puntaje?.toFixed(2)}  plays ${miles(t.plays ?? 0)}  ${donde}`);
	}

	if (values.muestra) {
		const pares = shortCodesDePares(leerJsonOpcional(RUTA_PARES));
		if (pares.length === 0) console.warn('Aviso: no encontré pares aceptados en pruebas/pares.json; la muestra no excluye ninguno.');
		const muestra = elegirMuestra(reels, {...MUESTRA_POR_DEFECTO, excluir: new Set(pares), medianaPuntaje: ranking.mediana_puntaje});
		const sinMp4 = muestra.miembros.filter((m) => m.mp4 === null).map((m) => m.shortCode);
		const faltanMotivos = sinMp4.filter((sc) => !motivosInsta.has(sc));
		for (const [sc, motivo] of await motivosInstaYoutube(RUTAS.db ?? SIN_CARPETA, faltanMotivos)) motivosInsta.set(sc, motivo);
		for (const m of muestra.miembros) {
			if (m.mp4 === null) m.nota = `sin mp4 local: ${textoFalta(motivosInsta.get(m.shortCode), intentoDe.get(m.shortCode))}`;
		}
		escribirJson(SALIDA_MUESTRA, {
			version: 1,
			generado_en: corpus.generado_en,
			generado_por: 'herramientas/estilo/corpus.ts --muestra',
			criterios: {
				top: `los ${MUESTRA_POR_DEFECTO.nTop} primeros del ranking histórico (sin los pares), tengan o no mp4 local`,
				recientes: `${MUESTRA_POR_DEFECTO.nRecientes} publicados del ${MUESTRA_POR_DEFECTO.recientesDesde.slice(0, 10)} al 2026-09-30 (UTC) con mp4 ${MUESTRA_POR_DEFECTO.resolucionRecientes}, que no estén ya; primero los que tienen puntaje, repartidos parejo por fecha`,
				resto: `${MUESTRA_POR_DEFECTO.nResto} con puntaje debajo de la mediana (${ranking.mediana_puntaje}) y mp4 local, repartidos parejo por fecha`,
				excluidos: 'los pares crudo↔reel aceptados de pruebas/pares.json (reels de prueba de la Fase 6)',
			},
			excluidos_pares: pares,
			n: muestra.n,
			candidatos: muestra.candidatos,
			reels: muestra.miembros,
		});
		console.log(
			`Muestra: top ${muestra.n.top} · recientes ${muestra.n.recientes} (de ${muestra.candidatos.recientes} candidatos, ${muestra.candidatos.recientes_con_puntaje} con puntaje) · ` +
				`resto ${muestra.n.resto} (de ${muestra.candidatos.resto}) = ${muestra.n.total}. Sin los pares: ${pares.join(', ') || 'ninguno'}.`,
		);
		console.log(`Escribí ${relative(RAIZ, SALIDA_CORPUS)} y ${relative(RAIZ, SALIDA_MUESTRA)}.`);
	} else {
		console.log(`Escribí ${relative(RAIZ, SALIDA_CORPUS)}.`);
	}
}

if (esPrincipal(import.meta.url)) void correr(main);

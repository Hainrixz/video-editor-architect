/**
 * aprender.ts: /aprender-estilo de punta a punta (Fase 2, cierre). Mide lo que falte en tus reels publicados y arma
 * estilo/estilo.json, estilo/momentos.jsonl y estilo/informe.md (con agregar.ts).
 *
 *   npx tsx herramientas/estilo/aprender.ts --muestra [--reels a,b] [--rehacer] [--rehacer-etapas overlays,cara]
 *                                           [--paralelo 2] [--sin-agregar] [--solo-agregar] [--sin-hojas]
 *
 *   --muestra         los 25 reels de estilo/muestra.json más los que ya se habían medido (referencias/reels/<sc>/ y
 *                     los 8 de estilo/mini-estilo.json). Es el conjunto por defecto; el comando excluido pide algún
 *                     argumento, por eso existe.
 *   --reels a,b       solo esos shortCodes (tienen que estar en estilo/corpus.json; los pares de prueba no entran).
 *   --rehacer         ignora el caché y vuelve a medir todo lo pedido. --rehacer-etapas solo esas etapas.
 *   --solo-agregar    no mide: agrega lo que ya está en el caché (y rehace hojas y tipografía si faltan).
 *
 * Etapas por reel (caché en referencias/reels/<sc>/, registro en referencias/reels/<sc>/aprender.json):
 *   subtitulos  → subtitulos.json   herramientas/estilo/medir.ts (Vision; proceso aparte)
 *   capas       → capas.json        herramientas/estilo/medir-capas.ts (titular, tarjetas y transcripcion.json)
 *   overlays    → overlays.json     herramientas/estilo/overlays.ts (stickers, inserts, SFX; escribe onsets.json)
 *   cara        → cara.json         Vision a 30 fps con silueta (herramientas/cara.ts → caraDeVideo)
 *   zooms       → zooms.json        saltos de tamaño de cara verificados con el fondo (lib/cara.ts)
 *   nivel_sfx   → nivel-sfx.json    nivel de cada SFX contra tu voz (ebur128 y RMS de 100 ms; solo ffmpeg)
 * Una etapa está vigente si su salida existe y no cambiaron el video (bytes y fecha), sus parámetros, lo que lee de otras
 * etapas ni el código que la produce (sha256 del archivo y de todo lo que importa). Lo medido antes de que existiera
 * este registro se adopta si es del mismo video y más nuevo que su código.
 *
 * Si otra pieza cambia una herramienta (o algo que importa), sus etapas vencen y la siguiente corrida las rehace;
 * `vigencia(reel)` dice qué está vigente sin medir nada.
 * Tiempo medido (2026-10-03, 2 a la vez): 2.5 min de cómputo por reel (p50); un reel de 1440p a 60 fps de 100 s, ~7 min
 * (los subtítulos con Vision son la etapa más larga). Con el caché al día, la corrida solo hace el cierre (~1–2 min).
 *
 * Al final (salvo --sin-agregar): comparación de tipografías (referencias/tipografia.json), agregar.ts → estilo.json,
 * momentos.jsonl e informe.md, y las hojas de ejemplo del informe (estilo/informe/*.jpg, chicas, + hojas.json), más
 * las hojas de tus 3 virales para revisarlas a ojo (out/aprender/virales/<sc>.jpg; lo que se ve va a
 * estilo/informe/revision-virales.json).
 *
 * No gasta nada: Gemini y la semántica quedan N/A (cuestan y necesitan tu sí). Tus reels y tus carpetas se leen sin
 * tocarse. Vision y whisper no corren dentro del sandbox: este comando está en excludedCommands (va SOLO en su llamada).
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida o falta algo tuyo (un mp4, el corpus, la muestra).
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';

// ───────────────────────────── Rutas ─────────────────────────────

export const DIR_REFERENCIAS = join(RAIZ, 'referencias', 'reels');
export const DIR_TRABAJO = join(RAIZ, 'out', 'aprender');
export const RUTA_CORPUS = join(RAIZ, 'estilo', 'corpus.json');
export const RUTA_MUESTRA = join(RAIZ, 'estilo', 'muestra.json');
export const RUTA_MINI_ESTILO = join(RAIZ, 'estilo', 'mini-estilo.json');
export const RUTA_PARES = join(RAIZ, 'pruebas', 'pares.json');
const TSX_LOCAL = join(RAIZ, 'node_modules', '.bin', 'tsx');

/** Desde esta fecha (UTC) y en 1440×2560, un reel es "reciente" para subtítulos y layout (plan: jun–sep, 1440p). */
export const DESDE_RECIENTES = '2026-06-01';
export const RESOLUCION_RECIENTES = '1440x2560';

// ───────────────────────────── Conjunto de reels ─────────────────────────────

export type GrupoReel = 'top' | 'recientes' | 'resto' | 'otros';

export type ReelConjunto = {
	shortCode: string;
	mp4: string;
	grupo: GrupoReel;
	/** ¿Está en estilo/muestra.json? (los medidos antes, no). */
	en_muestra: boolean;
	puntaje: number | null;
	rank: number | null;
	publicado_en: string | null;
	resolucion: string | null;
	fps: number | null;
	duracion_s: number | null;
	/** Publicado desde DESDE_RECIENTES y en 1440×2560: cuenta para subtítulos y layout. */
	reciente: boolean;
};

type ReelCorpus = {
	shortCode: string;
	publicado_en: string | null;
	duracion_s: number | null;
	resolucion: string | null;
	fps: number | null;
	mp4: string | null;
	puntaje: number | null;
	rank: number | null;
};

type Corpus = {dueno: {username: string; id: string}; ranking: {mediana_puntaje: number}; reels: ReelCorpus[]; top10: Array<{rank: number; shortCode: string; mp4: string | null; falta: string | null}>};
type Muestra = {reels: Array<{grupo: 'top' | 'recientes' | 'resto'; shortCode: string; mp4: string | null}>; excluidos_pares?: string[]};

function leerJson<T>(ruta: string, que: string, siguiente: string): T {
	if (!existsSync(ruta)) throw fallo(que, `no existe ${relative(RAIZ, ruta)}`, siguiente, 2);
	try {
		return JSON.parse(readFileSync(ruta, 'utf8')) as T;
	} catch (error) {
		throw fallo(que, `${relative(RAIZ, ruta)} no es JSON válido`, siguiente, 2, error);
	}
}

export const esReciente = (publicado: string | null, resolucion: string | null): boolean =>
	!!publicado && publicado.slice(0, 10) >= DESDE_RECIENTES && resolucion === RESOLUCION_RECIENTES;

/** Pares crudo ↔ reel de prueba (Fase 6): no entran al estilo. */
export function paresDePrueba(rutaPares = RUTA_PARES, muestra?: Muestra): Set<string> {
	const s = new Set<string>(muestra?.excluidos_pares ?? []);
	if (existsSync(rutaPares)) {
		try {
			type Par = {reel?: string; shortCode?: string; aceptado?: boolean};
			const p = JSON.parse(readFileSync(rutaPares, 'utf8')) as Par[] | {pares?: Par[]};
			for (const x of Array.isArray(p) ? p : (p.pares ?? [])) {
				const sc = x.shortCode ?? x.reel;
				if (sc && x.aceptado === true) s.add(sc);
			}
		} catch {
			// Si pares.json no se puede leer, quedan los excluidos de la muestra.
		}
	}
	return s;
}

/**
 * El conjunto que se mide: la muestra (25) más los reels que ya tenían mediciones (carpetas de referencias/reels/ con
 * capas.json u overlays.json, y los de estilo/mini-estilo.json), siempre que sean tuyos (estén en el corpus) y no sean
 * pares de prueba. Puro sobre los datos que recibe.
 */
export function armarConjunto(corpus: Corpus, muestra: Muestra, medidosAntes: string[], pares: Set<string>): {reels: ReelConjunto[]; avisos: string[]} {
	const porSc = new Map(corpus.reels.map((r) => [r.shortCode, r]));
	const avisos: string[] = [];
	const salida: ReelConjunto[] = [];
	const agregar = (sc: string, grupo: GrupoReel | null, enMuestra: boolean, mp4Muestra: string | null) => {
		if (salida.some((r) => r.shortCode === sc)) return;
		const c = porSc.get(sc);
		if (!c) {
			avisos.push(`${sc} no está en estilo/corpus.json (no es tuyo o no se capturó): no entra`);
			return;
		}
		if (pares.has(sc)) {
			avisos.push(`${sc} es un par de prueba (pruebas/pares.json): no entra al estilo`);
			return;
		}
		const mp4 = mp4Muestra ?? c.mp4;
		const reciente = esReciente(c.publicado_en, c.resolucion);
		salida.push({
			shortCode: sc,
			mp4: mp4 ?? '',
			grupo: grupo ?? (reciente ? 'recientes' : 'otros'),
			en_muestra: enMuestra,
			puntaje: c.puntaje,
			rank: c.rank,
			publicado_en: c.publicado_en,
			resolucion: c.resolucion,
			fps: c.fps,
			duracion_s: c.duracion_s,
			reciente,
		});
	};
	for (const r of muestra.reels) agregar(r.shortCode, r.grupo, true, r.mp4);
	for (const sc of [...medidosAntes].sort()) agregar(sc, null, false, null);
	return {reels: salida, avisos};
}

/** shortCodes con mediciones previas: carpetas de referencias/reels/ con capas.json u overlays.json + los del mini-estilo. */
export function medidosAntes(dir = DIR_REFERENCIAS, rutaMini = RUTA_MINI_ESTILO): string[] {
	const s = new Set<string>();
	if (existsSync(dir)) {
		for (const nombre of readdirSync(dir)) {
			const d = join(dir, nombre);
			if (!statSync(d).isDirectory() || nombre.startsWith('_')) continue;
			if (['capas.json', 'overlays.json', 'subtitulos.json'].some((f) => existsSync(join(d, f)))) s.add(nombre);
		}
	}
	if (existsSync(rutaMini)) {
		try {
			for (const r of (JSON.parse(readFileSync(rutaMini, 'utf8')) as {reels?: Array<{shortCode: string}>}).reels ?? []) s.add(r.shortCode);
		} catch {
			// mini-estilo roto: solo cuenta lo que hay en referencias/.
		}
	}
	return [...s];
}

export function leerConjunto(op: {reels?: string[]} = {}): {reels: ReelConjunto[]; avisos: string[]; corpus: Corpus; muestra: Muestra} {
	const corpus = leerJson<Corpus>(RUTA_CORPUS, 'leer el corpus', 'corre herramientas/estilo/corpus.ts');
	const muestra = leerJson<Muestra>(RUTA_MUESTRA, 'leer la muestra', 'corre herramientas/estilo/corpus.ts --muestra');
	const pares = paresDePrueba(RUTA_PARES, muestra);
	const {reels, avisos} = armarConjunto(corpus, muestra, medidosAntes(), pares);
	if (!op.reels?.length) return {reels, avisos, corpus, muestra};
	const pedidos = new Set(op.reels);
	const elegidos = reels.filter((r) => pedidos.has(r.shortCode));
	// Un reel pedido que no está en el conjunto, pero sí en el corpus, también se puede medir.
	const extra = armarConjunto(corpus, {reels: []}, [...pedidos].filter((sc) => !elegidos.some((r) => r.shortCode === sc)), pares);
	return {reels: [...elegidos, ...extra.reels], avisos: [...avisos, ...extra.avisos], corpus, muestra};
}

// ───────────────────────────── Huella del código ─────────────────────────────

const IMPORT_RELATIVO = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Archivos locales que importa un módulo (recursivo, solo rutas relativas), incluido él mismo. Ordenados. */
export function cierreDeImports(entrada: string): string[] {
	const vistos = new Set<string>();
	const pendientes = [resolve(entrada)];
	while (pendientes.length) {
		const ruta = pendientes.pop()!;
		if (vistos.has(ruta) || !existsSync(ruta)) continue;
		vistos.add(ruta);
		const texto = readFileSync(ruta, 'utf8');
		for (const m of texto.matchAll(IMPORT_RELATIVO)) {
			const base = resolve(dirname(ruta), m[1]);
			const candidatas = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
			const real = candidatas.find((c) => existsSync(c) && statSync(c).isFile());
			if (real) pendientes.push(real);
		}
	}
	return [...vistos].sort();
}

/** sha256 de varios archivos (rutas relativas a la raíz + contenido) y la fecha del más nuevo. */
export function huellaArchivos(archivos: string[], extra = ''): {sha256: string; mtimeMs: number} {
	const h = createHash('sha256');
	let mtimeMs = 0;
	for (const a of [...new Set(archivos)].sort()) {
		if (!existsSync(a)) continue;
		h.update(relative(RAIZ, a));
		h.update(readFileSync(a));
		mtimeMs = Math.max(mtimeMs, statSync(a).mtimeMs);
	}
	h.update(extra);
	return {sha256: h.digest('hex'), mtimeMs};
}

// ───────────────────────────── Etapas ─────────────────────────────

export const ETAPAS = ['subtitulos', 'capas', 'overlays', 'cara', 'zooms', 'nivel_sfx'] as const;
export type Etapa = (typeof ETAPAS)[number];

/** Salida principal de cada etapa (en referencias/reels/<sc>/). */
export const SALIDAS: Record<Etapa, string> = {
	subtitulos: 'subtitulos.json',
	capas: 'capas.json',
	overlays: 'overlays.json',
	cara: 'cara.json',
	zooms: 'zooms.json',
	nivel_sfx: 'nivel-sfx.json',
};

/** Versión de lo que este archivo implementa por dentro (súbela si cambias cómo se calcula una etapa en proceso). */
export const VERSION_EN_PROCESO: Partial<Record<Etapa, string>> = {cara: 'cara-30fps-silueta-1', zooms: 'zooms-fondo-1', nivel_sfx: 'nivel-sfx-1'};

const H = (...partes: string[]) => join(RAIZ, 'herramientas', ...partes);

/** El texto de una función de un archivo (de su firma a la llave que la cierra en la columna 0). Pura. */
export function fuenteDeFuncion(ruta: string, nombre: string): string {
	if (!existsSync(ruta)) return '';
	const texto = readFileSync(ruta, 'utf8');
	const inicio = texto.search(new RegExp(`^(export )?(async )?function ${nombre}\\b`, 'm'));
	if (inicio < 0) return texto;
	const fin = texto.indexOf('\n}\n', inicio);
	return texto.slice(inicio, fin < 0 ? undefined : fin + 2);
}

/** Código que decide el resultado de cada etapa: cierre de imports del CLI o de la biblioteca + fuentes Swift. */
export function codigoDeEtapa(e: Etapa): {archivos: string[]; extra: string} {
	switch (e) {
		case 'subtitulos':
			return {archivos: [...cierreDeImports(H('estilo', 'medir.ts')), H('vision', 'ocr.swift')], extra: ''};
		case 'capas':
			return {archivos: [...cierreDeImports(H('estilo', 'medir-capas.ts')), H('vision', 'ocr.swift')], extra: ''};
		case 'overlays':
			return {archivos: cierreDeImports(H('estilo', 'overlays.ts')), extra: ''};
		case 'cara':
			// De herramientas/cara.ts solo cuenta caraDeVideo (lo demás es el CLI y la cara de los proyectos).
			return {archivos: [...cierreDeImports(H('lib', 'cara.ts')), H('vision', 'cara.swift')], extra: `${VERSION_EN_PROCESO.cara ?? ''}\n${fuenteDeFuncion(H('cara.ts'), 'caraDeVideo')}`};
		case 'zooms':
			return {archivos: cierreDeImports(H('lib', 'cara.ts')), extra: VERSION_EN_PROCESO.zooms ?? ''};
		case 'nivel_sfx': {
			// De lib/sfx.ts solo cuenta cómo se mide la sonoridad (lo demás es el catálogo y el selector).
			const sfx = H('lib', 'sfx.ts');
			const funciones = ['medirSonoridad', 'parsearMetadatosEbur128', 'ffmpegTexto'].map((f) => fuenteDeFuncion(sfx, f)).join('\n');
			return {archivos: [H('lib', 'fallo.ts')], extra: `${VERSION_EN_PROCESO.nivel_sfx ?? ''}\n${funciones}`};
		}
	}
}

export type FirmaMp4 = {ruta: string; bytes: number; mtimeMs: number};

export type RegistroEtapa = {
	estado: 'ok' | 'fallo';
	salida: string;
	codigo: string;
	entradas: string;
	fecha: string;
	segundos: number | null;
	adoptado: boolean;
	/** De dónde se adoptó (si se adoptó). */
	origen: string | null;
	error: string | null;
	/** Algo que hay que saber de cómo se midió (p. ej. sin voz). */
	nota?: string;
};

export type ManifestReel = {version: 1; shortCode: string; mp4: FirmaMp4; etapas: Partial<Record<Etapa, RegistroEtapa>>};

export const dirReel = (sc: string) => join(DIR_REFERENCIAS, sc);
const rutaManifestReel = (sc: string) => join(dirReel(sc), 'aprender.json');

export function firmaMp4(ruta: string): FirmaMp4 {
	const st = statSync(ruta);
	return {ruta, bytes: st.size, mtimeMs: Math.round(st.mtimeMs)};
}

function leerManifestReel(sc: string, mp4: FirmaMp4): ManifestReel {
	const ruta = rutaManifestReel(sc);
	if (existsSync(ruta)) {
		try {
			const m = JSON.parse(readFileSync(ruta, 'utf8')) as ManifestReel;
			if (m.version === 1 && m.shortCode === sc) return {...m, mp4};
		} catch {
			// Un registro roto se rehace.
		}
	}
	return {version: 1, shortCode: sc, mp4, etapas: {}};
}

function escribirJsonAtomico(ruta: string, datos: unknown, sangria: string | undefined = '\t'): void {
	mkdirSync(dirname(ruta), {recursive: true});
	const tmp = `${ruta}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(datos, null, sangria)}\n`);
	renameSync(tmp, ruta);
}

function guardarManifestReel(m: ManifestReel): void {
	escribirJsonAtomico(rutaManifestReel(m.shortCode), m);
}

/**
 * Franja de subtítulos que se le pasa a overlays.ts: la de por defecto (centros 1495–1505 ± 75 px), ensanchada solo si
 * tus subtítulos de ese reel caen fuera (centros p10–p90 medidos ± 75 px). Con menos de 10 subtítulos, la de por defecto.
 */
export const FRANJA_OVERLAYS_POR_DEFECTO: [number, number] = [1420, 1580];

export function franjaParaOverlays(subs: {n?: number; resumen?: {y_p10: number | null; y_p90: number | null}} | null): [number, number] {
	const [a, b] = FRANJA_OVERLAYS_POR_DEFECTO;
	const r = subs?.resumen;
	if (!subs || !r || (subs.n ?? 0) < 10 || r.y_p10 === null || r.y_p90 === null) return [a, b];
	return [Math.min(a, Math.round(r.y_p10 - 75)), Math.max(b, Math.round(r.y_p90 + 75))];
}

function leerSiExiste<T>(ruta: string): T | null {
	if (!existsSync(ruta)) return null;
	try {
		return JSON.parse(readFileSync(ruta, 'utf8')) as T;
	} catch {
		return null;
	}
}

/** Parámetros y entradas de cada etapa (lo que, si cambia, obliga a rehacerla). */
function entradasDeEtapa(e: Etapa, r: ReelConjunto, mp4: FirmaMp4): {params: Record<string, unknown>; deps: string[]} {
	const d = dirReel(r.shortCode);
	switch (e) {
		case 'subtitulos':
			return {params: {}, deps: []};
		case 'capas':
			return {params: {}, deps: [join(d, 'subtitulos.json')]};
		case 'overlays': {
			const subs = leerSiExiste<{n?: number; resumen?: {y_p10: number | null; y_p90: number | null}}>(join(d, 'subtitulos.json'));
			return {params: {franja: franjaParaOverlays(subs)}, deps: []};
		}
		case 'cara':
			return {params: {fps_muestreo: 30, silueta: true}, deps: []};
		case 'zooms':
			return {params: {}, deps: [join(d, 'cara.json')]};
		case 'nivel_sfx':
			return {params: {mp4: mp4.bytes}, deps: [join(d, 'overlays.json'), join(d, 'onsets.json'), join(d, 'transcripcion.json')]};
	}
}

function huellaEntradas(e: Etapa, r: ReelConjunto, mp4: FirmaMp4): string {
	const {params, deps} = entradasDeEtapa(e, r, mp4);
	const h = createHash('sha256');
	h.update(JSON.stringify({mp4: {bytes: mp4.bytes, mtimeMs: mp4.mtimeMs}, params}));
	for (const dep of deps) h.update(existsSync(dep) ? readFileSync(dep) : Buffer.from('falta'));
	return h.digest('hex');
}

// ───────────────────────────── Adopción de lo medido antes ─────────────────────────────

type Candidata = {ruta: string; video: (j: Record<string, unknown>) => unknown; extra?: (j: Record<string, unknown>) => boolean};

function candidatasAdopcion(e: Etapa, r: ReelConjunto): Candidata[] {
	const d = dirReel(r.shortCode);
	const sc = r.shortCode;
	switch (e) {
		case 'subtitulos':
			return [
				{ruta: join(d, 'subtitulos.json'), video: (j) => j.video},
				{ruta: join(RAIZ, 'out', 'f1-mini-estilo', `${sc}.json`), video: (j) => j.video},
				{ruta: join(RAIZ, 'out', 'f2-capas', 'subtitulos', `${sc}.json`), video: (j) => j.video},
			];
		case 'capas':
			return [{ruta: join(d, 'capas.json'), video: (j) => j.video}];
		case 'overlays': {
			const subs = leerSiExiste<{n?: number; resumen?: {y_p10: number | null; y_p90: number | null}}>(join(d, 'subtitulos.json'));
			const franja = franjaParaOverlays(subs);
			return [
				{
					ruta: join(d, 'overlays.json'),
					video: (j) => j.fuente,
					extra: (j) => JSON.stringify(j.franja_subtitulos) === JSON.stringify(franja) && existsSync(join(d, 'onsets.json')),
				},
			];
		}
		case 'cara':
			return [
				{ruta: join(d, 'cara.json'), video: (j) => j.fuente, extra: (j) => j.fps_muestreo === 30},
				{ruta: join(RAIZ, 'out', 'f2-cara', `cara-${sc}.json`), video: (j) => j.fuente, extra: (j) => j.fps_muestreo === 30},
			];
		default:
			return [];
	}
}

const mismoVideo = (valor: unknown, mp4: string): boolean => typeof valor === 'string' && (resolve(RAIZ, valor) === resolve(mp4) || valor === mp4);

/** Si hay una medición previa del mismo video y más nueva que su código, la copia al caché y la registra. */
function adoptar(e: Etapa, r: ReelConjunto, man: ManifestReel, codigo: {sha256: string; mtimeMs: number}): boolean {
	const destino = join(dirReel(r.shortCode), SALIDAS[e]);
	for (const c of candidatasAdopcion(e, r)) {
		if (!existsSync(c.ruta)) continue;
		const st = statSync(c.ruta);
		if (st.mtimeMs < codigo.mtimeMs) continue;
		let j: Record<string, unknown>;
		try {
			j = JSON.parse(readFileSync(c.ruta, 'utf8')) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (!mismoVideo(c.video(j), r.mp4)) continue;
		if (c.extra && !c.extra(j)) continue;
		if (resolve(c.ruta) !== resolve(destino)) {
			mkdirSync(dirname(destino), {recursive: true});
			copyFileSync(c.ruta, destino);
		}
		man.etapas[e] = {
			estado: 'ok',
			salida: relative(RAIZ, destino),
			codigo: codigo.sha256,
			entradas: huellaEntradas(e, r, man.mp4),
			fecha: new Date(st.mtimeMs).toISOString(),
			segundos: null,
			adoptado: true,
			origen: relative(RAIZ, c.ruta),
			error: null,
		};
		return true;
	}
	return false;
}

// ───────────────────────────── Procesos hijos ─────────────────────────────

type ResultadoHijo = {codigo: number; segundos: number; cola: string};

/** Corre `tsx <script> args` en la raíz, con el log completo en `rutaLog`. */
export function correrTsx(script: string, args: string[], rutaLog: string, timeoutMs = 30 * 60_000): Promise<ResultadoHijo> {
	mkdirSync(dirname(rutaLog), {recursive: true});
	const log = createWriteStream(rutaLog);
	const t0 = performance.now();
	const [cmd, pre] = existsSync(TSX_LOCAL) ? [TSX_LOCAL, [] as string[]] : ['npx', ['tsx']];
	return new Promise((resolver) => {
		const hijo = spawn(cmd, [...pre, script, ...args], {cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe']});
		let cola = '';
		const guardar = (d: Buffer) => {
			log.write(d);
			cola = (cola + d.toString()).slice(-3000);
		};
		hijo.stdout.on('data', guardar);
		hijo.stderr.on('data', guardar);
		const reloj = setTimeout(() => {
			cola += `\n[aprender] se pasó de ${Math.round(timeoutMs / 60000)} min: lo detengo`;
			hijo.kill('SIGKILL');
		}, timeoutMs);
		hijo.on('error', (e) => {
			clearTimeout(reloj);
			log.end();
			resolver({codigo: 1, segundos: 0, cola: `no pude arrancar ${cmd}: ${e.message}`});
		});
		hijo.on('close', (codigo) => {
			clearTimeout(reloj);
			log.end();
			resolver({codigo: codigo ?? 1, segundos: Number(((performance.now() - t0) / 1000).toFixed(1)), cola});
		});
	});
}

const ultimaFrase = (cola: string): string => {
	const lineas = cola.trim().split('\n').filter((l) => l.trim());
	return (lineas.findLast((l) => l.startsWith('No pude')) ?? lineas.at(-1) ?? 'sin salida').slice(0, 400);
};

// ───────────────────────────── Nivel de los SFX contra tu voz ─────────────────────────────

export type PalabraT = {d: number; h: number};
export type BloqueM = [number, number];

/** Media de potencia con las compuertas de EBU R128 (absoluta −70 LUFS y relativa −10 LU) sobre bloques de 400 ms. */
export function integradaConCompuertas(valores: number[]): number | null {
	const v = valores.filter((m) => Number.isFinite(m) && m > -70);
	if (v.length === 0) return null;
	const pot = (m: number) => Math.pow(10, m / 10);
	const media = (xs: number[]) => xs.reduce((s, x) => s + pot(x), 0) / xs.length;
	const relativa = 10 * Math.log10(media(v)) - 10;
	const quedan = v.filter((m) => m > relativa);
	if (quedan.length === 0) return null;
	return 10 * Math.log10(media(quedan));
}

const dentroDePalabra = (t: number, palabras: readonly PalabraT[]) => palabras.some((p) => t >= p.d && t <= p.h);
const onsetCerca = (a: number, b: number, onsets: readonly number[]) => onsets.some((o) => o >= a && o <= b);

/**
 * Sonoridad integrada de tu voz (LUFS) con los bloques M de ebur128 (fin de ventana, 400 ms): solo bloques con su
 * centro dentro de una palabra y sin ningún onset de SFX dentro de la ventana (± 0.1 s). Pura.
 */
export function vozIntegrada(bloques: readonly BloqueM[], palabras: readonly PalabraT[], onsets: readonly number[]): {lufs: number | null; n: number} {
	const elegidos = bloques.filter(([t]) => dentroDePalabra(t - 0.2, palabras) && !onsetCerca(t - 0.5, t + 0.1, onsets)).map(([, m]) => m);
	return {lufs: integradaConCompuertas(elegidos), n: elegidos.length};
}

export type NivelEvento = {
	id: string;
	clase: string;
	onset_s: number;
	confiable: boolean;
	/** M (LUFS) del último bloque que termina antes del onset: tu voz sola. */
	m_antes: number | null;
	/** M máximo de los bloques que terminan 0.1–0.5 s después del onset (traen el ataque del SFX). */
	m_despues: number | null;
	/** M estimado del SFX solo: resta de potencias (después − antes). null si no sube ≥ 1 dB. */
	m_sfx: number | null;
	/** m_sfx − LUFS integrado de tu voz (lo que usa el selector). */
	lu_vs_voz: number | null;
	/** RMS de 100 ms más alto en [onset − 0.02, onset + 0.3] (dBFS, mezcla con tu voz). */
	rms_pico_dbfs: number | null;
	/** rms_pico − mediana del RMS de 100 ms de tu voz (dB). */
	db_vs_voz_rms: number | null;
};

/** Estimación del nivel de un SFX en la mezcla publicada (pura). */
export function nivelDeEvento(
	ev: {id: string; clase: string; onset_s: number; confiable: boolean},
	bloques: readonly BloqueM[],
	vozLufs: number | null,
	rms: {pico: (t0: number, t1: number) => number | null; vozDb: number | null},
): NivelEvento {
	const o = ev.onset_s;
	let antes: BloqueM | null = null;
	for (const b of bloques) if (b[0] <= o - 0.02 && (!antes || b[0] > antes[0])) antes = b;
	const despues = bloques.filter(([t]) => t >= o + 0.1 - 1e-6 && t <= o + 0.5 + 1e-6).map(([, m]) => m);
	const mDespues = despues.length ? Math.max(...despues) : null;
	const mAntes = antes && Number.isFinite(antes[1]) ? antes[1] : null;
	let mSfx: number | null = null;
	if (mDespues !== null && Number.isFinite(mDespues)) {
		if (mAntes === null || mAntes < -70) mSfx = mDespues;
		else if (mDespues - mAntes >= 1) mSfx = 10 * Math.log10(Math.pow(10, mDespues / 10) - Math.pow(10, mAntes / 10));
	}
	const pico = rms.pico(o - 0.02, o + 0.3);
	const r1 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
	return {
		id: ev.id,
		clase: ev.clase,
		onset_s: ev.onset_s,
		confiable: ev.confiable,
		m_antes: r1(mAntes),
		m_despues: r1(mDespues),
		m_sfx: r1(mSfx),
		lu_vs_voz: mSfx !== null && vozLufs !== null ? r1(mSfx - vozLufs) : null,
		rms_pico_dbfs: r1(pico),
		db_vs_voz_rms: pico !== null && rms.vozDb !== null ? r1(pico - rms.vozDb) : null,
	};
}

/** RMS de ventanas de 100 ms sobre PCM mono (dBFS). */
export function rmsVentana(pcm: Float32Array, fs: number, t0: number, largo = 0.1): number | null {
	const a = Math.max(0, Math.round(t0 * fs));
	const b = Math.min(pcm.length, a + Math.round(largo * fs));
	if (b - a < largo * fs * 0.5) return null;
	let s = 0;
	for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
	const rms = Math.sqrt(s / (b - a));
	return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function cuantilSimple(v: number[], p: number): number | null {
	const s = v.filter(Number.isFinite).sort((a, b) => a - b);
	if (!s.length) return null;
	const h = (s.length - 1) * p;
	const lo = Math.floor(h);
	const hi = Math.min(s.length - 1, lo + 1);
	return Math.round((s[lo] + (h - lo) * (s[hi] - s[lo])) * 10) / 10;
}

function decodificarMono(mp4: string, fs: number): Float32Array {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', mp4, '-vn', '-ac', '1', '-ar', String(fs), '-f', 'f32le', '-'], {maxBuffer: 1 << 30});
	if (r.status !== 0 || !r.stdout) throw fallo(`leer el audio de ${basename(mp4)}`, `ffmpeg terminó con ${r.status}`, 'revisa que el reel traiga audio', 1, String(r.stderr));
	const b = r.stdout as Buffer;
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

type EventoOverlay = {id: string; clase: string; subtipo: string; desde: number; sfx: {con_sfx: boolean; onset_s: number | null; confiable: boolean} | null};

/** Etapa nivel_sfx de un reel: lee overlays, onsets y transcripción; mide con ffmpeg (ebur128 y PCM). */
export async function medirNivelSfx(r: ReelConjunto): Promise<unknown> {
	const d = dirReel(r.shortCode);
	const ov = leerSiExiste<{eventos: EventoOverlay[]}>(join(d, 'overlays.json'));
	const on = leerSiExiste<{onsets: Array<{t: number}>; lateral?: {usado: boolean; nota: string}; canales?: number}>(join(d, 'onsets.json'));
	const tr = leerSiExiste<{palabras: PalabraT[]}>(join(d, 'transcripcion.json'));
	if (!ov || !on) throw fallo(`medir el nivel de los SFX de ${r.shortCode}`, 'faltan overlays.json u onsets.json', 'corre antes la etapa overlays', 2);
	const {medirSonoridad} = await import('../lib/sfx.ts');
	const son = medirSonoridad(r.mp4, 0);
	const bloques = son.m as BloqueM[];
	const onsets = on.onsets.map((o) => o.t);
	const palabras = tr?.palabras ?? [];
	const voz = vozIntegrada(bloques, palabras, onsets);
	const FS = 16000;
	const pcm = decodificarMono(r.mp4, FS);
	const vozRms: number[] = [];
	for (let t = 0; t + 0.1 <= pcm.length / FS; t += 0.05) {
		const c = t + 0.05;
		if (!dentroDePalabra(c, palabras) || onsetCerca(c - 0.4, c + 0.4, onsets)) continue;
		const v = rmsVentana(pcm, FS, t);
		if (v !== null && Number.isFinite(v)) vozRms.push(v);
	}
	const vozDb = cuantilSimple(vozRms, 0.5);
	const pico = (t0: number, t1: number) => {
		let max: number | null = null;
		for (let t = Math.max(0, t0); t <= t1; t += 0.01) {
			const v = rmsVentana(pcm, FS, t);
			if (v !== null && Number.isFinite(v) && (max === null || v > max)) max = v;
		}
		return max;
	};
	const eventos = ov.eventos
		.filter((e) => e.subtipo !== 'desenfoque' && e.sfx?.con_sfx && e.sfx.onset_s !== null)
		.map((e) => nivelDeEvento({id: e.id, clase: e.clase, onset_s: e.sfx!.onset_s!, confiable: !!e.sfx!.confiable}, bloques, voz.lufs, {pico, vozDb}));
	const lus = eventos.map((e) => e.lu_vs_voz).filter((x): x is number => x !== null);
	const dbs = eventos.map((e) => e.db_vs_voz_rms).filter((x): x is number => x !== null);
	const lusConf = eventos.filter((e) => e.confiable).map((e) => e.lu_vs_voz).filter((x): x is number => x !== null);
	return {
		version: 1,
		generado_por: 'herramientas/estilo/aprender.ts (etapa nivel_sfx)',
		fuente: r.mp4,
		metodo: {
			voz_lufs: 'bloques M de ebur128 (400 ms, cada 100 ms) con el centro dentro de una palabra de transcripcion.json y sin onsets de SFX en la ventana ± 0.1 s; media de potencia con compuertas EBU R128 (−70 LUFS y −10 LU)',
			m_sfx: 'M máximo de los bloques que terminan 0.1–0.5 s después del onset, menos (en potencia) el M del último bloque que termina antes del onset; sin dato si sube < 1 dB',
			lu_vs_voz: 'm_sfx − LUFS integrado de tu voz (lo mismo que usa el selector: sonoridad momentánea máx. del SFX − LUFS integrado de la voz)',
			rms: 'RMS de 100 ms (mono 16 kHz): pico en [onset − 0.02, onset + 0.3] s contra la mediana de tus ventanas de voz (centro dentro de una palabra, sin onsets a ± 0.4 s)',
			eventos: 'capas de overlays.json con un onset a ±3 cuadros de su aparición (con_sfx)',
		},
		lateral: on.lateral ?? null,
		voz: {lufs_integrado: voz.lufs === null ? null : Math.round(voz.lufs * 10) / 10, n_bloques: voz.n, i_total_lufs: son.i_lufs, rms_mediana_dbfs: vozDb, n_ventanas_rms: vozRms.length, palabras: palabras.length},
		eventos,
		resumen: {
			n: eventos.length,
			n_con_lu: lus.length,
			lu_vs_voz: {p10: cuantilSimple(lus, 0.1), p50: cuantilSimple(lus, 0.5), p90: cuantilSimple(lus, 0.9)},
			lu_vs_voz_confiables: {p10: cuantilSimple(lusConf, 0.1), p50: cuantilSimple(lusConf, 0.5), p90: cuantilSimple(lusConf, 0.9), n: lusConf.length},
			db_vs_voz_rms: {p10: cuantilSimple(dbs, 0.1), p50: cuantilSimple(dbs, 0.5), p90: cuantilSimple(dbs, 0.9), n: dbs.length},
		},
	};
}

// ───────────────────────────── Una etapa de un reel ─────────────────────────────

type OpcionesCorrida = {rehacer: Set<Etapa> | 'todo' | null; avisar: (m: string) => void};

async function correrEtapa(e: Etapa, r: ReelConjunto, man: ManifestReel, op: OpcionesCorrida): Promise<'vigente' | 'adoptada' | 'medida' | 'fallo'> {
	const d = dirReel(r.shortCode);
	const salida = join(d, SALIDAS[e]);
	const cod = codigoDeEtapa(e);
	const codigo = huellaArchivos(cod.archivos, cod.extra);
	const entradas = huellaEntradas(e, r, man.mp4);
	const forzar = op.rehacer === 'todo' || (op.rehacer instanceof Set && op.rehacer.has(e));
	const reg = man.etapas[e];
	if (!forzar && reg?.estado === 'ok' && existsSync(salida) && reg.codigo === codigo.sha256 && reg.entradas === entradas) return 'vigente';
	if (!forzar && !reg && adoptar(e, r, man, codigo)) {
		guardarManifestReel(man);
		return 'adoptada';
	}
	const rutaLog = join(DIR_TRABAJO, 'logs', `${r.shortCode}-${e}.log`);
	const t0 = performance.now();
	let error: string | null = null;
	let segundos: number | null = null;
	let nota: string | null = null;
	try {
		if (e === 'subtitulos' || e === 'capas' || e === 'overlays') {
			const args: string[] = [r.mp4, '--salida', salida];
			if (e === 'capas') args.push('--subtitulos', join(d, 'subtitulos.json'));
			if (e === 'overlays') args.push('--franja', (entradasDeEtapa(e, r, man.mp4).params.franja as number[]).join(','));
			const script = {subtitulos: 'herramientas/estilo/medir.ts', capas: 'herramientas/estilo/medir-capas.ts', overlays: 'herramientas/estilo/overlays.ts'}[e];
			let res = await correrTsx(script, args, rutaLog);
			// Un reel sin tu voz (solo música): el titular y las tarjetas se miden igual, sin alinear con lo dicho.
			if (e === 'capas' && res.codigo !== 0 && /no encontr[óo] voz/i.test(res.cola)) {
				nota = 'sin voz que transcribir (el VAD no encontró habla): medido con --sin-habla';
				const otra = await correrTsx(script, [...args, '--sin-habla'], rutaLog.replace(/\.log$/, '-sin-habla.log'));
				res = {...otra, segundos: res.segundos + otra.segundos};
			}
			segundos = res.segundos;
			if (res.codigo !== 0) error = `${script} salió con ${res.codigo}: ${ultimaFrase(res.cola)}`;
		} else if (e === 'cara') {
			const {caraDeVideo} = await import('../cara.ts');
			await caraDeVideo(r.mp4, salida, {fpsMuestreo: 30, silueta: true});
		} else if (e === 'zooms') {
			const {detectarZooms, leerCara, verificarZoomsConFondo} = await import('../lib/cara.ts');
			const cara = leerCara(join(d, 'cara.json'));
			const zooms = detectarZooms(cara);
			const todos = detectarZooms(cara, {todos: true});
			const verificados = await verificarZoomsConFondo(r.mp4, cara, zooms);
			const veredictos: Record<string, number> = {};
			for (const z of verificados) veredictos[z.fondo.veredicto] = (veredictos[z.fondo.veredicto] ?? 0) + 1;
			escribirJsonAtomico(salida, {
				version: 1,
				generado_por: 'herramientas/estilo/aprender.ts (etapa zooms: lib/cara.ts → detectarZooms + verificarZoomsConFondo)',
				fuente: r.mp4,
				fps_muestreo: cara.fps_muestreo,
				duracion_s: cara.duracion_s,
				cobertura: cara.resumen.cobertura,
				metodo: 'salto de tamaño de cara > 7 % entre dos cuadros seguidos (puntos de Vision, la caja acompaña, se sostiene, origen creíble); luego el fondo decide: "zoom" = el fondo también crece o se encoge (zoom de edición), "sin-zoom" = corte entre tomas donde tú te moviste',
				candidatos: zooms.length,
				descartados: todos.filter((z) => z.descarte !== null).length,
				por_veredicto: veredictos,
				confirmados: verificados.filter((z) => z.fondo.veredicto === 'zoom').length,
				zooms: verificados,
			});
		} else if (e === 'nivel_sfx') {
			escribirJsonAtomico(salida, await medirNivelSfx(r));
		}
	} catch (err) {
		error = err instanceof Error ? err.message.split('\n')[0] : String(err);
		writeFileSync(rutaLog, `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	}
	if (segundos === null) segundos = Number(((performance.now() - t0) / 1000).toFixed(1));
	if (!error && !existsSync(salida)) error = `no se escribió ${relative(RAIZ, salida)}`;
	man.etapas[e] = {
		estado: error ? 'fallo' : 'ok',
		salida: relative(RAIZ, salida),
		codigo: codigo.sha256,
		entradas: huellaEntradas(e, r, man.mp4),
		fecha: new Date().toISOString(),
		segundos,
		adoptado: false,
		origen: null,
		error,
		...(nota ? {nota} : {}),
	};
	guardarManifestReel(man);
	if (error) op.avisar(`  ✗ ${r.shortCode} ${e}: ${error} (log: ${relative(RAIZ, rutaLog)})`);
	return error ? 'fallo' : 'medida';
}

/**
 * ¿Qué etapas de un reel siguen vigentes con el código y las entradas de hoy? (no mide nada). "falta" = nunca se
 * midió o falló; "vencida" = cambió el video, sus parámetros, sus entradas o el código que la produce.
 */
export function vigencia(r: ReelConjunto): Record<Etapa, 'vigente' | 'vencida' | 'falta'> {
	const salida = {} as Record<Etapa, 'vigente' | 'vencida' | 'falta'>;
	const man = r.mp4 && existsSync(r.mp4) ? leerManifestReel(r.shortCode, firmaMp4(r.mp4)) : null;
	for (const e of ETAPAS) {
		const reg = man?.etapas[e];
		if (!man || !reg || reg.estado !== 'ok' || !existsSync(join(dirReel(r.shortCode), SALIDAS[e]))) {
			salida[e] = 'falta';
			continue;
		}
		const cod = codigoDeEtapa(e);
		salida[e] = reg.codigo === huellaArchivos(cod.archivos, cod.extra).sha256 && reg.entradas === huellaEntradas(e, r, man.mp4) ? 'vigente' : 'vencida';
	}
	return salida;
}

export type ResumenReel = {shortCode: string; etapas: Partial<Record<Etapa, string>>; segundos: number; fallos: string[]};

async function medirReel(r: ReelConjunto, op: OpcionesCorrida): Promise<ResumenReel> {
	const t0 = performance.now();
	const resumen: ResumenReel = {shortCode: r.shortCode, etapas: {}, segundos: 0, fallos: []};
	if (!r.mp4 || !existsSync(r.mp4)) {
		resumen.fallos.push(`no existe el mp4 (${r.mp4 || 'sin ruta en el corpus'})`);
		op.avisar(`  ✗ ${r.shortCode}: no existe el mp4 (${r.mp4 || 'sin ruta'})`);
		return resumen;
	}
	const man = leerManifestReel(r.shortCode, firmaMp4(r.mp4));
	mkdirSync(dirReel(r.shortCode), {recursive: true});
	for (const e of ETAPAS) {
		// Una etapa cuyas entradas fallaron no se intenta.
		const necesita: Partial<Record<Etapa, Etapa[]>> = {capas: ['subtitulos'], overlays: ['subtitulos'], zooms: ['cara'], nivel_sfx: ['overlays']};
		const rotas = (necesita[e] ?? []).filter((x) => resumen.etapas[x] === 'fallo');
		if (rotas.length) {
			resumen.etapas[e] = 'fallo';
			resumen.fallos.push(`${e}: no se intentó porque falló ${rotas.join(', ')}`);
			continue;
		}
		const estado = await correrEtapa(e, r, man, op);
		resumen.etapas[e] = estado;
		if (estado === 'fallo') resumen.fallos.push(`${e}: ${man.etapas[e]?.error ?? 'falló'}`);
	}
	resumen.segundos = Number(((performance.now() - t0) / 1000).toFixed(1));
	const cuenta = (x: string) => Object.values(resumen.etapas).filter((v) => v === x).length;
	op.avisar(`· ${r.shortCode} (${r.grupo}${r.en_muestra ? '' : ', medido antes'}): ${cuenta('medida')} medidas, ${cuenta('adoptada')} adoptadas, ${cuenta('vigente')} vigentes, ${cuenta('fallo')} fallos · ${resumen.segundos} s`);
	return resumen;
}

/** Corre `tareas` con a lo más `n` a la vez, en orden. */
export async function enParalelo<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
	const salida: R[] = new Array(items.length);
	let siguiente = 0;
	const trabajador = async () => {
		while (siguiente < items.length) {
			const i = siguiente++;
			salida[i] = await f(items[i]);
		}
	};
	await Promise.all(Array.from({length: Math.max(1, Math.min(n, items.length))}, trabajador));
	return salida;
}

// ───────────────────────────── CLI ─────────────────────────────

const USO = 'npx tsx herramientas/estilo/aprender.ts --muestra [--reels a,b] [--rehacer] [--rehacer-etapas overlays,cara] [--paralelo 2] [--sin-agregar] [--solo-agregar] [--sin-hojas]';

async function main(): Promise<void> {
	let v: Record<string, string | boolean | undefined>;
	try {
		v = parseArgs({
			allowPositionals: false,
			options: {
				muestra: {type: 'boolean', default: false},
				reels: {type: 'string'},
				rehacer: {type: 'boolean', default: false},
				'rehacer-etapas': {type: 'string'},
				paralelo: {type: 'string', default: '2'},
				'sin-agregar': {type: 'boolean', default: false},
				'solo-agregar': {type: 'boolean', default: false},
				'sin-hojas': {type: 'boolean', default: false},
			},
		}).values;
	} catch (error) {
		throw fallo('leer los argumentos', error instanceof Error ? error.message.split('\n')[0] : 'no tienen la forma esperada', `usa ${USO}`, 2);
	}
	const reelsPedidos = typeof v.reels === 'string' ? v.reels.split(',').map((s) => s.trim()).filter(Boolean) : [];
	if (!v.muestra && !reelsPedidos.length && !v['solo-agregar']) throw fallo('saber qué medir', 'no pediste --muestra, --reels ni --solo-agregar', `usa ${USO}`, 2);
	const paralelo = Number(v.paralelo);
	if (!Number.isInteger(paralelo) || paralelo < 1 || paralelo > 6) throw fallo('leer --paralelo', `"${v.paralelo}" no es un entero de 1 a 6`, 'usa --paralelo 2', 2);
	let rehacer: OpcionesCorrida['rehacer'] = v.rehacer ? 'todo' : null;
	if (typeof v['rehacer-etapas'] === 'string') {
		const pedidas = v['rehacer-etapas'].split(',').map((s) => s.trim());
		const malas = pedidas.filter((p) => !(ETAPAS as readonly string[]).includes(p));
		if (malas.length) throw fallo('leer --rehacer-etapas', `no conozco ${malas.join(', ')}`, `usa algunas de: ${ETAPAS.join(', ')}`, 2);
		rehacer = new Set(pedidas as Etapa[]);
	}
	const {reels, avisos} = leerConjunto({reels: reelsPedidos});
	for (const a of avisos) console.log(`Aviso: ${a}`);
	if (!reels.length) throw fallo('armar el conjunto de reels', 'ninguno de los pedidos está en el corpus', 'revisa los shortCodes de --reels', 2);
	const t0 = performance.now();
	let resumenes: ResumenReel[] = [];
	if (!v['solo-agregar']) {
		const nMuestra = reels.filter((r) => r.en_muestra).length;
		console.log(`Midiendo ${reels.length} reels (${nMuestra} de la muestra y ${reels.length - nMuestra} medidos antes), ${paralelo} a la vez. Caché: ${relative(RAIZ, DIR_REFERENCIAS)}/<sc>/.`);
		resumenes = await enParalelo(reels, paralelo, (r) => medirReel(r, {rehacer, avisar: (m) => console.log(m)}));
		const fallidos = resumenes.filter((x) => x.fallos.length);
		console.log(`Medición: ${reels.length - fallidos.length} de ${reels.length} reels completos en ${((performance.now() - t0) / 60000).toFixed(1)} min.`);
		for (const f of fallidos) console.log(`  ${f.shortCode}: ${f.fallos.join(' · ')}`);
		escribirJsonAtomico(join(DIR_TRABAJO, 'ultima-corrida.json'), {fecha: new Date().toISOString(), reels: resumenes});
	}
	if (v['sin-agregar']) return;
	await cerrarAprendizaje(reels, {hojas: !v['sin-hojas']});
	if (resumenes.some((x) => x.fallos.length)) process.exitCode = 1;
}

// ───────────────────────────── Cierre: tipografía, agregación, informe y hojas ─────────────────────────────

/** Tipografía, agregación (agregar.ts), informe y hojas de ejemplo. */
export async function cerrarAprendizaje(reels: ReelConjunto[], op: {hojas: boolean}): Promise<void> {
	const t0 = performance.now();
	const tipografia = await asegurarTipografia(reels, (m) => console.log(m));
	console.log(`Tipografía: ${Object.entries(tipografia.capas).map(([k, v]) => {
		const e = v?.elegida ?? v?.ranking[0];
		return `${k} → ${e ? `${e.id} ${e.peso} (IoU ${e.parecido_p50}, n=${v?.n_muestras})` : 'N/A'}`;
	}).join(' · ')}`);
	const ag = await import('./agregar.ts');
	const r = ag.agregarYEscribir();
	console.log(`Estilo: ${r.stats.length} reels → ${r.conteo.medidas} métricas medidas, ${r.conteo.supuestos} supuestos y ${r.conteo.na} N/A. Momentos: ${r.momentos.length}.`);
	if (op.hojas) {
		const hojas = await armarHojas(r.stats, r.estilo, reels, (m) => console.log(m));
		console.log(`Hojas: ${hojas.map((h) => `${h.archivo} (${Math.round(h.bytes / 1024)} KB)`).join(', ')}`);
		await hojasVirales(reels, (m) => console.log(m));
	}
	const informe = ag.informeMarkdown(r.estilo, r.stats, ag.datosInforme(r.estilo, r.stats, reels));
	escribirTexto(ag.RUTA_INFORME, informe);
	console.log(`Listo en ${((performance.now() - t0) / 1000).toFixed(0)} s: estilo/estilo.json, estilo/momentos.jsonl, estilo/informe.md${op.hojas ? ' y estilo/informe/*.jpg' : ''}.`);
}

function escribirTexto(ruta: string, texto: string): void {
	mkdirSync(dirname(ruta), {recursive: true});
	const tmp = `${ruta}.tmp-${process.pid}`;
	writeFileSync(tmp, texto);
	renameSync(tmp, ruta);
}

// ───────────────────────────── Tipografía: recortes reales contra las candidatas ─────────────────────────────

export const RUTA_TIPOGRAFIA = join(RAIZ, 'referencias', 'tipografia.json');
const DIR_TIPO = join(DIR_TRABAJO, 'tipografia');
export const VERSION_TIPOGRAFIA = 'tipografia-3';

export type CapaTipo = 'subtitulos' | 'titular' | 'tarjetas';
/** Candidatas (id, peso) que se comparan: las tres del plan con los pesos que hay en biblioteca/fuentes. */
export const CANDIDATAS_TIPO: ReadonlyArray<{id: 'tiktok-sans' | 'instrument-sans' | 'inter'; peso: number}> = [
	{id: 'tiktok-sans', peso: 600},
	{id: 'tiktok-sans', peso: 800},
	{id: 'instrument-sans', peso: 600},
	{id: 'instrument-sans', peso: 700},
	{id: 'inter', peso: 600},
	{id: 'inter', peso: 700},
	{id: 'inter', peso: 800},
];

/** Máscara binaria (1 = tinta) recortada a su caja de tinta. */
export type Mascara = {w: number; h: number; px: Uint8Array};

/** Recorta una máscara a la caja de lo que vale 1 (null si está vacía). */
export function recortarMascara(m: Mascara): Mascara | null {
	let x0 = m.w;
	let y0 = m.h;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < m.h; y++) {
		for (let x = 0; x < m.w; x++) {
			if (!m.px[y * m.w + x]) continue;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
		}
	}
	if (x1 < 0) return null;
	const w = x1 - x0 + 1;
	const h = y1 - y0 + 1;
	const px = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = m.px[(y + y0) * m.w + x + x0];
	return {w, h, px};
}

/**
 * Parecido entre dos máscaras ya recortadas a su tinta (pura): IoU con las dos centradas, probando corrimientos de
 * ±3 px en x y ±2 px en y (el ruido de las orillas). También el ancho y la tinta relativos (b ÷ a).
 */
export function parecidoMascaras(a: Mascara, b: Mascara): {iou: number; ancho_rel: number; tinta_rel: number} {
	const W = Math.max(a.w, b.w) + 8;
	const Hh = Math.max(a.h, b.h) + 6;
	const colocar = (m: Mascara) => {
		const out = new Uint8Array(W * Hh);
		const ox = Math.floor((W - m.w) / 2);
		const oy = Math.floor((Hh - m.h) / 2);
		for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) out[(y + oy) * W + x + ox] = m.px[y * m.w + x];
		return out;
	};
	const A = colocar(a);
	const B = colocar(b);
	const areaA = A.reduce((s, v) => s + v, 0);
	const areaB = B.reduce((s, v) => s + v, 0);
	let mejor = 0;
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -3; dx <= 3; dx++) {
			let inter = 0;
			for (let y = Math.max(0, -dy); y < Math.min(Hh, Hh - dy); y++) {
				const fa = y * W;
				const fb = (y + dy) * W;
				for (let x = Math.max(0, -dx); x < Math.min(W, W - dx); x++) if (A[fa + x] && B[fb + x + dx]) inter++;
			}
			const iou = inter / (areaA + areaB - inter || 1);
			if (iou > mejor) mejor = iou;
		}
	}
	return {iou: Number(mejor.toFixed(4)), ancho_rel: Number((b.w / a.w).toFixed(4)), tinta_rel: Number((areaB / (areaA || 1)).toFixed(4))};
}

/**
 * Tinta de un texto dibujado (relleno blanco con contorno negro): lo claro ENCERRADO por lo oscuro, es decir, lo
 * claro que no se alcanza desde la orilla del recorte sin cruzar el contorno. Pura.
 */
export function mascaraRellenoEncerrado(rgba: Uint8Array, w: number, h: number, op: {oscuro?: number; claro?: number} = {}): Mascara {
	const oscuro = op.oscuro ?? 90;
	const claro = op.claro ?? 185;
	const n = w * h;
	const esOscuro = new Uint8Array(n);
	for (let p = 0; p < n; p++) esOscuro[p] = Math.max(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]) <= oscuro ? 1 : 0;
	const alcanzado = new Uint8Array(n);
	const cola: number[] = [];
	const meter = (p: number) => {
		if (!alcanzado[p] && !esOscuro[p]) {
			alcanzado[p] = 1;
			cola.push(p);
		}
	};
	for (let x = 0; x < w; x++) {
		meter(x);
		meter((h - 1) * w + x);
	}
	for (let y = 0; y < h; y++) {
		meter(y * w);
		meter(y * w + w - 1);
	}
	while (cola.length) {
		const p = cola.pop()!;
		const x = p % w;
		const y = (p - x) / w;
		if (x > 0) meter(p - 1);
		if (x < w - 1) meter(p + 1);
		if (y > 0) meter(p - w);
		if (y < h - 1) meter(p + w);
	}
	const px = new Uint8Array(n);
	for (let p = 0; p < n; p++) px[p] = !alcanzado[p] && !esOscuro[p] && Math.min(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]) >= claro ? 1 : 0;
	return {w, h, px};
}

/** Tinta oscura sobre una caja blanca (tus tarjetas): oscuro y sin color. Pura. */
export function mascaraTextoOscuro(rgba: Uint8Array, w: number, h: number, umbral = 110): Mascara {
	const px = new Uint8Array(w * h);
	for (let p = 0; p < w * h; p++) {
		const r = rgba[p * 4];
		const g = rgba[p * 4 + 1];
		const b = rgba[p * 4 + 2];
		px[p] = Math.max(r, g, b) <= umbral && Math.max(r, g, b) - Math.min(r, g, b) <= 40 ? 1 : 0;
	}
	return {w, h, px};
}

type Fk = import('../lib/texto-ancho.ts').FuenteFk;

/** Path SVG de un texto con fontkit (unidades = px con `tamano`), y su caja de tinta. */
function pathDeTexto(fuente: Fk, texto: string, tamano: number): {d: string; x0: number; y0: number; x1: number; y1: number} {
	const corrida = fuente.layout(texto);
	const s = tamano / fuente.unitsPerEm;
	const partes: string[] = [];
	let x = 0;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	const f = (v: number) => +v.toFixed(2);
	corrida.glyphs.forEach((g, i) => {
		const p = corrida.positions[i];
		const ox = x + p.xOffset * s;
		const oy = -p.yOffset * s;
		for (const c of g.path.commands) {
			const a = c.args;
			const px = (k: number) => f(ox + a[k] * s);
			const py = (k: number) => f(oy - a[k] * s);
			if (c.command === 'moveTo') partes.push(`M${px(0)} ${py(1)}`);
			else if (c.command === 'lineTo') partes.push(`L${px(0)} ${py(1)}`);
			else if (c.command === 'quadraticCurveTo') partes.push(`Q${px(0)} ${py(1)} ${px(2)} ${py(3)}`);
			else if (c.command === 'bezierCurveTo') partes.push(`C${px(0)} ${py(1)} ${px(2)} ${py(3)} ${px(4)} ${py(5)}`);
			else if (c.command === 'closePath') partes.push('Z');
		}
		const b = g.bbox;
		if (b.minX !== null && b.maxX !== null && b.minY !== null && b.maxY !== null && b.maxX > b.minX) {
			x0 = Math.min(x0, ox + b.minX * s);
			x1 = Math.max(x1, ox + b.maxX * s);
			y0 = Math.min(y0, oy - b.maxY * s);
			y1 = Math.max(y1, oy - b.minY * s);
		}
		x += p.xAdvance * s;
	});
	return {d: partes.join(''), x0, y0, x1, y1};
}

/** Máscara de un texto dibujado con una candidata, con el mismo alto de tinta que `alto` (px). */
export async function mascaraCandidata(ruta: string, texto: string, alto: number): Promise<Mascara | null> {
	const {abrirFuente} = await import('../lib/texto-ancho.ts');
	const {Resvg} = await import('@resvg/resvg-js');
	const fuente = abrirFuente(join(RAIZ, ruta));
	const prueba = pathDeTexto(fuente, texto, 100);
	const altoPrueba = prueba.y1 - prueba.y0;
	if (!(altoPrueba > 0)) return null;
	const tam = (100 * alto) / altoPrueba;
	const p = pathDeTexto(fuente, texto, tam);
	const w = Math.ceil(p.x1 - p.x0) + 6;
	const h = Math.ceil(p.y1 - p.y0) + 6;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path transform="translate(${(3 - p.x0).toFixed(2)} ${(3 - p.y0).toFixed(2)})" d="${p.d}" fill="#000"/></svg>`;
	const img = new Resvg(svg, {fitTo: {mode: 'original'}}).render();
	const px = new Uint8Array(img.width * img.height);
	const datos = img.pixels;
	for (let i = 0; i < px.length; i++) px[i] = datos[i * 4 + 3] >= 128 ? 1 : 0;
	return recortarMascara({w: img.width, h: img.height, px});
}

type EspecMuestra = {capa: CapaTipo; reel: string; id: string; texto: string; n: number; recorte: {x: number; y: number; w: number; h: number}};

const soloTexto = (t: string) => /^[\p{L}\p{N} ¿?¡!.,]+$/u.test(t) && t.replace(/\s/g, '').length >= 5;

/** Qué recortes se comparan: por reel reciente, hasta 3 subtítulos, las líneas del titular y hasta 3 tarjetas. */
function muestrasDeReel(r: ReelConjunto): EspecMuestra[] {
	const d = dirReel(r.shortCode);
	const subs = leerSiExiste<{ancho: number; alto: number; total_cuadros: number; eventos: Array<{id: string; texto: string; palabras: number; lineas: number; confianza: number; nDesde: number; nHasta: number; x: number; y: number; ancho: number; alto_caja: number}>}>(join(d, 'subtitulos.json'));
	const capas = leerSiExiste<{ancho: number; total_cuadros: number; titular: {presente: boolean; lineas?: Array<{texto: string; x_centro: number; y_centro: number; ancho: number; alto_caja: number}>}; tarjetas: Array<{id: string; texto: string; lineas: number; emoji: boolean; grande: boolean; escritura: boolean; lista: string | null; palabras: number; nDesde: number; nHasta: number; orillas: {x0: number; y0: number; x1: number; y1: number}; habla: {tipo: string} | null}>}>(join(d, 'capas.json'));
	const salida: EspecMuestra[] = [];
	const esc = (ancho: number) => ancho / 1080;
	if (subs && subs.eventos.length >= MIN_SUBS_TIPO) {
		const k = esc(subs.ancho);
		const elegibles = subs.eventos.filter((e) => e.lineas === 1 && e.palabras >= 2 && e.palabras <= 3 && e.confianza >= 0.5 && soloTexto(e.texto) && e.nHasta - e.nDesde >= 6);
		const paso = Math.max(1, Math.floor(elegibles.length / 3));
		for (let i = 0; i < elegibles.length && salida.length < 3; i += paso) {
			const e = elegibles[i];
			salida.push({capa: 'subtitulos', reel: r.shortCode, id: e.id, texto: e.texto, n: Math.floor((e.nDesde + e.nHasta - 1) / 2), recorte: {x: (e.x - e.ancho / 2 - 14) * k, y: (e.y - e.alto_caja / 2 - 14) * k, w: (e.ancho + 28) * k, h: (e.alto_caja + 28) * k}});
		}
	}
	if (capas?.titular.presente) {
		const k = esc(capas.ancho);
		for (const [i, l] of (capas.titular.lineas ?? []).entries()) {
			if (!soloTexto(l.texto)) continue;
			salida.push({capa: 'titular', reel: r.shortCode, id: `titular-${i + 1}`, texto: l.texto, n: Math.floor(capas.total_cuadros * 0.4), recorte: {x: (l.x_centro - l.ancho / 2 - 18) * k, y: (l.y_centro - l.alto_caja / 2 - 14) * k, w: (l.ancho + 36) * k, h: (l.alto_caja + 28) * k}});
		}
	}
	if (capas) {
		const k = esc(capas.ancho);
		const elegibles = capas.tarjetas.filter((t) => t.lineas === 1 && !t.emoji && !t.grande && !t.escritura && t.palabras <= 3 && t.habla?.tipo === 'literal' && soloTexto(t.texto));
		for (const t of elegibles.slice(0, 3)) {
			const o = t.orillas;
			salida.push({capa: 'tarjetas', reel: r.shortCode, id: t.id, texto: t.texto, n: Math.max(t.nDesde, t.nHasta - 2), recorte: {x: (o.x0 + 8) * k, y: (o.y0 + 8) * k, w: (o.x1 - o.x0 - 16) * k, h: (o.y1 - o.y0 - 16) * k}});
		}
	}
	return salida;
}

const MIN_SUBS_TIPO = 10;

/** Compara tus recortes reales con las candidatas y escribe referencias/tipografia.json (con caché por entradas). */
export async function asegurarTipografia(reels: readonly ReelConjunto[], avisar: (m: string) => void): Promise<import('./agregar.ts').Tipografia> {
	const recientes = reels.filter((r) => r.reciente && r.mp4 && existsSync(r.mp4)).sort((a, b) => String(b.publicado_en).localeCompare(String(a.publicado_en)));
	const elegidos = recientes.slice(0, 10);
	const entradas = createHash('sha256');
	entradas.update(VERSION_TIPOGRAFIA);
	for (const r of elegidos) for (const f of ['subtitulos.json', 'capas.json']) {
		const ruta = join(dirReel(r.shortCode), f);
		entradas.update(existsSync(ruta) ? readFileSync(ruta) : Buffer.from('falta'));
	}
	for (const c of CANDIDATAS_TIPO) entradas.update(c.id + c.peso);
	const huella = entradas.digest('hex');
	const previa = leerSiExiste<import('./agregar.ts').Tipografia & {entradas?: string}>(RUTA_TIPOGRAFIA);
	if (previa?.entradas === huella) return previa;
	avisar(`Comparando tipografías en ${elegidos.length} reels recientes…`);
	const {extraerCuadros} = await import('./medir-capas.ts');
	const {sondear} = await import('../lib/ffprobe.ts');
	const {CANDIDATAS} = await import('../../src/estilo/fuentes.ts');
	const {guardarPng} = await import('./medir-capas.ts');
	mkdirSync(DIR_TIPO, {recursive: true});
	type Resultado = {espec: EspecMuestra; real: Mascara; por: Array<{id: string; peso: number; iou: number; ancho_rel: number; tinta_rel: number}>};
	const resultados: Resultado[] = [];
	for (const r of elegidos) {
		const especs = muestrasDeReel(r);
		if (!especs.length) continue;
		const s = await sondear(r.mp4);
		const v = {ruta: r.mp4, ancho: s.video.anchoVisible, alto: s.video.altoVisible, fps: s.video.fpsReal, totalCuadros: s.video.cuadros ?? Math.round(s.duracion * s.video.fpsReal), duracion: s.duracion};
		const porCuadro = new Map<number, EspecMuestra[]>();
		for (const e of especs) porCuadro.set(e.n, [...(porCuadro.get(e.n) ?? []), e]);
		const recortes: Array<{espec: EspecMuestra; rgba: Uint8Array; w: number; h: number}> = [];
		await extraerCuadros(v, [...porCuadro.keys()], (n, rgba, w, h) => {
			for (const e of porCuadro.get(n) ?? []) {
				const x0 = Math.max(0, Math.floor(e.recorte.x));
				const y0 = Math.max(0, Math.floor(e.recorte.y));
				const x1 = Math.min(w, Math.ceil(e.recorte.x + e.recorte.w));
				const y1 = Math.min(h, Math.ceil(e.recorte.y + e.recorte.h));
				if (x1 - x0 < 10 || y1 - y0 < 10) continue;
				const cw = x1 - x0;
				const ch = y1 - y0;
				const sub = new Uint8Array(cw * ch * 4);
				for (let y = 0; y < ch; y++) rgba.copy(sub, y * cw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x1) * 4);
				recortes.push({espec: e, rgba: sub, w: cw, h: ch});
			}
		});
		for (const rc of recortes) {
			const cruda = rc.espec.capa === 'tarjetas' ? mascaraTextoOscuro(rc.rgba, rc.w, rc.h) : mascaraRellenoEncerrado(rc.rgba, rc.w, rc.h);
			const real = recortarMascara(cruda);
			if (!real || real.h < 12 || real.w < real.h) continue;
			const area = real.px.reduce((a, b) => a + b, 0);
			if (area < 300) continue;
			const por: Resultado['por'] = [];
			for (const c of CANDIDATAS_TIPO) {
				const ruta = CANDIDATAS[c.id].archivos[c.peso]?.ruta;
				if (!ruta) continue;
				const m = await mascaraCandidata(ruta, rc.espec.texto, real.h);
				if (!m) continue;
				por.push({id: c.id, peso: c.peso, ...parecidoMascaras(real, m)});
			}
			resultados.push({espec: rc.espec, real, por});
			await guardarPng(join(DIR_TIPO, `${rc.espec.reel}-${rc.espec.id}.png`), rc.rgba, rc.w, rc.h);
		}
	}
	const capas: import('./agregar.ts').Tipografia['capas'] = {};
	const cuantil50 = (v: number[]) => {
		const s = [...v].sort((a, b) => a - b);
		return s.length ? Number((s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(4)) : 0;
	};
	// Familia: con TODAS las muestras juntas (tus capas usan la misma letra), por muestra el mejor peso de cada familia.
	const familias = [...new Set(CANDIDATAS_TIPO.map((c) => c.id))].map((id) => {
		const xs = resultados.map((x) => Math.max(...x.por.filter((p) => p.id === id).map((p) => p.iou), -1)).filter((v) => v >= 0);
		return {id, parecido_p50: cuantil50(xs), n: xs.length};
	}).filter((f) => f.n > 0).sort((a, b) => b.parecido_p50 - a.parecido_p50);
	const familia = familias[0]?.id ?? null;
	for (const capa of ['subtitulos', 'titular', 'tarjetas'] as const) {
		const rs = resultados.filter((x) => x.espec.capa === capa);
		const ranking = CANDIDATAS_TIPO.map((c) => {
			const xs = rs.flatMap((x) => x.por.filter((p) => p.id === c.id && p.peso === c.peso));
			return {id: c.id, peso: c.peso, parecido_p50: cuantil50(xs.map((p) => p.iou)), ancho_rel_p50: cuantil50(xs.map((p) => p.ancho_rel)), tinta_rel_p50: cuantil50(xs.map((p) => p.tinta_rel)), n: xs.length};
		})
			.filter((x) => x.n > 0)
			.sort((a, b) => b.parecido_p50 - a.parecido_p50);
		// La de más parecido; si otras quedan a < 0.02 de IoU, de esas la de tinta más cercana a la tuya (el peso).
		const mejor = ranking[0];
		const elegida = mejor ? ranking.filter((r) => mejor.parecido_p50 - r.parecido_p50 < 0.02).sort((a, b) => Math.abs(a.tinta_rel_p50 - 1) - Math.abs(b.tinta_rel_p50 - 1))[0] : undefined;
		const notas: string[] = [];
		if (rs.length === 0) notas.push('ningún recorte limpio de esta capa en tus reels recientes');
		if (mejor && elegida && (mejor.id !== elegida.id || mejor.peso !== elegida.peso)) notas.push(`${mejor.id} ${mejor.peso} y ${elegida.id} ${elegida.peso} quedan a < 0.02 de IoU (${mejor.parecido_p50} y ${elegida.parecido_p50}); se elige ${elegida.id} ${elegida.peso} porque su tinta se parece más a la tuya (${elegida.tinta_rel_p50} contra ${mejor.tinta_rel_p50})`);
		else if (ranking.length > 1 && ranking[0].parecido_p50 - ranking[1].parecido_p50 < 0.02) notas.push(`las dos primeras quedan a menos de 0.02 de IoU (${ranking[0].id} ${ranking[0].peso} y ${ranking[1].id} ${ranking[1].peso}): revísalo a ojo en la hoja de tipografía`);
		if (familia && elegida && elegida.id !== familia) notas.push(`con todas tus capas juntas gana ${familia}; en esta capa gana ${elegida.id}`);
		capas[capa] = {n_muestras: rs.length, reels: [...new Set(rs.map((x) => x.espec.reel))], ranking, ...(elegida ? {elegida} : {}), ...(notas.length ? {nota: notas.join('; ')} : {})};
	}
	const salida = {
		version: 1 as const,
		generado_en: new Date().toISOString(),
		entradas: huella,
		metodo:
			'recortes reales de tus reels recientes (subtítulos de 2–3 palabras en 1 línea, cada renglón del titular y tarjetas de 1 renglón sin emoji que dijiste tal cual) contra cada candidata dibujada con fontkit + resvg con el mismo texto (el que leyó Vision) y el mismo alto de tinta. Tinta real: en subtítulos y titular, el relleno blanco encerrado por el contorno (el contorno va por fuera de la letra, como se midió en el titular); en tarjetas, lo oscuro dentro de la caja blanca. parecido = IoU de las máscaras centradas (±3 px); ancho_rel y tinta_rel = candidata ÷ real (1 = igual)',
		familias,
		familia,
		capas,
		muestras: resultados.map((x) => ({capa: x.espec.capa, reel: x.espec.reel, id: x.espec.id, texto: x.espec.texto, alto_px: x.real.h, ancho_px: x.real.w, png: relative(RAIZ, join(DIR_TIPO, `${x.espec.reel}-${x.espec.id}.png`)), por: x.por})),
	};
	escribirJsonAtomico(RUTA_TIPOGRAFIA, salida);
	return salida;
}

// ───────────────────────────── Hojas del informe (JPG chicos) ─────────────────────────────

const MAX_BYTES_HOJA = 150 * 1024;

/** Un cuadro (o un recorte) de un video como JPEG en memoria (ffmpeg; el original no se toca). */
function cuadroJpeg(mp4: string, t: number, op: {ancho: number; recorte?: {x: number; y: number; w: number; h: number}; cajas?: Array<{x: number; y: number; w: number; h: number; color: string}>}): Buffer | null {
	const filtros: string[] = [];
	// Coordenadas en base 1080×1920: primero se lleva el cuadro a la base.
	filtros.push('scale=1080:1920');
	for (const c of op.cajas ?? []) filtros.push(`drawbox=x=${Math.round(c.x)}:y=${Math.round(c.y)}:w=${Math.max(2, Math.round(c.w))}:h=${Math.max(2, Math.round(c.h))}:color=${c.color}:t=5`);
	if (op.recorte) {
		const r = op.recorte;
		const x = Math.max(0, Math.round(r.x));
		const y = Math.max(0, Math.round(r.y));
		filtros.push(`crop=${Math.min(1080 - x, Math.round(r.w))}:${Math.min(1920 - y, Math.round(r.h))}:${x}:${y}`);
	}
	filtros.push(`scale=${op.ancho}:-2`);
	const res = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-ss', t.toFixed(3), '-i', mp4, '-frames:v', '1', '-vf', filtros.join(','), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', '-'], {maxBuffer: 1 << 26});
	return res.status === 0 && res.stdout && res.stdout.length > 0 ? (res.stdout as Buffer) : null;
}

type Celda = {jpeg: Buffer; ancho: number; alto: number; etiqueta: string};

/** Arma una hoja (SVG → PNG con resvg → JPG con ffmpeg) de celdas en rejilla, con título y etiquetas. */
async function componerHoja(ruta: string, titulo: string, celdas: Celda[], columnas: number): Promise<number> {
	const {Resvg} = await import('@resvg/resvg-js');
	const {abrirFuente} = await import('../lib/texto-ancho.ts');
	const rutaFuente = join(RAIZ, 'biblioteca', 'fuentes', 'tiktok-sans', 'TikTokSans-SemiBold.ttf');
	const familia = existsSync(rutaFuente) ? abrirFuente(rutaFuente).familyName : 'sans-serif';
	const sep = 8;
	const cab = 34;
	const pie = 26;
	const anchoCelda = Math.max(...celdas.map((c) => c.ancho));
	const altoCelda = Math.max(...celdas.map((c) => c.alto));
	const filas = Math.ceil(celdas.length / columnas);
	const W = columnas * anchoCelda + (columnas + 1) * sep;
	const H = cab + filas * (altoCelda + pie + sep) + sep;
	const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const partes = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#1b1b1b"/>`, `<text x="${sep}" y="24" font-family="${familia}" font-size="19" fill="#ffffff">${esc(titulo)}</text>`];
	celdas.forEach((c, i) => {
		const col = i % columnas;
		const fila = Math.floor(i / columnas);
		const x = sep + col * (anchoCelda + sep);
		const y = cab + fila * (altoCelda + pie + sep);
		partes.push(`<image x="${x}" y="${y}" width="${c.ancho}" height="${c.alto}" href="data:image/jpeg;base64,${c.jpeg.toString('base64')}"/>`);
		partes.push(`<text x="${x}" y="${y + c.alto + 18}" font-family="${familia}" font-size="13" fill="#d8d8d8">${esc(c.etiqueta.slice(0, Math.floor(anchoCelda / 6.4)))}</text>`);
	});
	partes.push('</svg>');
	const png = new Resvg(partes.join(''), {font: {loadSystemFonts: false, fontFiles: existsSync(rutaFuente) ? [rutaFuente] : [], defaultFontFamily: familia}, fitTo: {mode: 'original'}}).render().asPng();
	const tmp = join(DIR_TRABAJO, `hoja-${process.pid}.png`);
	mkdirSync(DIR_TRABAJO, {recursive: true});
	writeFileSync(tmp, png);
	mkdirSync(dirname(ruta), {recursive: true});
	let bytes = Infinity;
	for (const q of [5, 7, 9, 12, 16, 20, 25, 31]) {
		const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-q:v', String(q), ruta]);
		if (r.status !== 0) throw fallo(`armar la hoja ${basename(ruta)}`, 'ffmpeg no pudo escribir el JPG', 'revisa proyectos/_logs/fallos.log', 1, String(r.stderr));
		bytes = statSync(ruta).size;
		if (bytes <= MAX_BYTES_HOJA) break;
	}
	return bytes;
}

type StatsParaHojas = import('./agregar.ts').EstadisticasReel;

/** Las 4–6 hojas de ejemplo del informe (estilo/informe/*.jpg) y su índice estilo/informe/hojas.json. */
export async function armarHojas(stats: readonly StatsParaHojas[], estilo: Record<string, unknown>, reels: readonly ReelConjunto[], avisar: (m: string) => void): Promise<Array<{archivo: string; bytes: number}>> {
	const {DIR_INFORME} = await import('./agregar.ts');
	const mp4De = new Map(reels.map((r) => [r.shortCode, r.mp4]));
	const g = (ruta: string): unknown => ruta.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), estilo);
	const num = (ruta: string): number | null => {
		const v = (g(ruta) as {valor?: unknown} | undefined)?.valor;
		return typeof v === 'number' ? v : null;
	};
	const hojas: Array<{archivo: string; titulo: string; que_muestra: string; bytes: number}> = [];
	const hacer = async (nombre: string, titulo: string, que: string, celdas: Celda[], columnas: number) => {
		if (!celdas.length) {
			avisar(`  hoja ${nombre}: sin ejemplos, no se arma`);
			return;
		}
		const ruta = join(DIR_INFORME, nombre);
		const bytes = await componerHoja(ruta, titulo, celdas, columnas);
		hojas.push({archivo: `informe/${nombre}`, titulo, que_muestra: que, bytes});
	};
	const recientes = stats.filter((s) => s.reciente && mp4De.get(s.sc));

	// 1) Subtítulos y titular: cuadro entero con la franja medida (cian) y la caja del titular (amarillo).
	const y10 = num('franja_subtitulos.y_p10');
	const y90 = num('franja_subtitulos.y_p90');
	const cap = num('subtitulos.alto_mayuscula_p50') ?? 43;
	const celdas1: Celda[] = [];
	for (const s of recientes.filter((x) => x.subs.aporta && x.titular.presente).slice(0, 4)) {
		const t = (s.duracion_s ?? 20) * 0.35;
		const cajas = [] as Array<{x: number; y: number; w: number; h: number; color: string}>;
		if (s.titular.caja) cajas.push({x: s.titular.caja.x0, y: s.titular.caja.y0, w: s.titular.caja.x1 - s.titular.caja.x0, h: s.titular.caja.y1 - s.titular.caja.y0, color: 'yellow@0.9'});
		if (y10 !== null && y90 !== null) cajas.push({x: 60, y: y10 - cap, w: 960, h: y90 - y10 + 2 * cap, color: 'cyan@0.9'});
		const jpeg = cuadroJpeg(mp4De.get(s.sc)!, t, {ancho: 270, cajas});
		if (jpeg) celdas1.push({jpeg, ancho: 270, alto: 480, etiqueta: `${s.sc} · t=${t.toFixed(1)} s`});
	}
	await hacer('subtitulos-titular.jpg', 'Subtítulos (franja medida, cian) y titular (amarillo)', `Cuatro de tus reels recientes con la franja medida de los subtítulos (centro ${y10 ?? 'N/A'}–${y90 ?? 'N/A'} px ± una mayúscula) y la caja del titular medida.`, celdas1, 4);

	// 2) Tarjetas: recortes de tarjetas de varios reels (una de lista si hay).
	const celdas2: Celda[] = [];
	const usados = new Set<string>();
	const tarjetas = stats.flatMap((s) => s.capas.filter((c) => c.clase === 'tarjeta').map((c) => ({s, c})));
	const elegir = (f: (x: {s: StatsParaHojas; c: StatsParaHojas['capas'][number]}) => boolean, max: number) => {
		for (const x of tarjetas.filter(f)) {
			if (celdas2.length >= max || usados.has(x.s.sc)) continue;
			const mp4 = mp4De.get(x.s.sc);
			if (!mp4) continue;
			const pad = 40;
			const jpeg = cuadroJpeg(mp4, (x.c.desde + x.c.hasta) / 2, {ancho: 300, recorte: {x: 40, y: x.c.caja.y0 - pad - 40, w: 1000, h: x.c.caja.y1 - x.c.caja.y0 + 2 * pad + 80}});
			if (!jpeg) continue;
			usados.add(x.s.sc);
			const altoCelda = Math.round(((x.c.caja.y1 - x.c.caja.y0 + 2 * pad + 80) * 300) / 1000);
			celdas2.push({jpeg, ancho: 300, alto: altoCelda, etiqueta: `${x.s.sc}: "${x.c.texto ?? ''}"${x.c.lista ? ' (lista)' : ''}`});
		}
	};
	elegir((x) => x.c.lista !== null, 2);
	elegir((x) => x.c.lista === null && (x.c.texto?.length ?? 0) > 3, 8);
	await hacer('tarjetas.jpg', 'Tarjetas de palabra clave', `Tarjetas medidas en ${new Set(tarjetas.map((x) => x.s.sc)).size} reels: caja blanca, texto negro, a la altura del pecho (centro p50 ${num('tarjetas.centro_y.p50') ?? 'N/A'} px).`, celdas2, 4);

	// 3) Stickers: recortes con su caja.
	const celdas3: Celda[] = [];
	const stickers = stats.flatMap((s) => s.capas.filter((c) => c.clase === 'sticker').map((c) => ({s, c})));
	const porReel = new Map<string, number>();
	for (const x of stickers) {
		if (celdas3.length >= 8 || (porReel.get(x.s.sc) ?? 0) >= 2) continue;
		const mp4 = mp4De.get(x.s.sc);
		if (!mp4) continue;
		const w = x.c.caja.x1 - x.c.caja.x0;
		const h = x.c.caja.y1 - x.c.caja.y0;
		const lado = Math.max(w, h) + 120;
		const cx = (x.c.caja.x0 + x.c.caja.x1) / 2;
		const cy = (x.c.caja.y0 + x.c.caja.y1) / 2;
		const jpeg = cuadroJpeg(mp4, Math.min(x.c.hasta - 0.05, x.c.desde + 0.4), {ancho: 200, recorte: {x: Math.max(0, cx - lado / 2), y: Math.max(0, cy - lado / 2), w: lado, h: lado}});
		if (!jpeg) continue;
		porReel.set(x.s.sc, (porReel.get(x.s.sc) ?? 0) + 1);
		celdas3.push({jpeg, ancho: 200, alto: 200, etiqueta: `${x.s.sc} · ${Math.round(w)} px${x.c.sfx?.con_sfx ? ' · con SFX' : ''}`});
	}
	await hacer('stickers.jpg', 'Stickers', `Stickers detectados (ancho p50 ${num('stickers.ancho_px.p50') ?? 'N/A'} px, centro Y ${num('stickers.centro_y') ?? 'N/A'} px).`, celdas3, 4);

	// 4) Inserts: a pantalla completa y en tarjeta.
	const celdas4: Celda[] = [];
	const inserts = stats.flatMap((s) => s.capas.filter((c) => c.clase === 'insert').map((c) => ({s, c})));
	const porReelI = new Map<string, number>();
	for (const x of [...inserts.filter((i) => i.c.subtipo === 'capa'), ...inserts.filter((i) => i.c.subtipo !== 'capa')]) {
		if (celdas4.length >= 4 || (porReelI.get(x.s.sc) ?? 0) >= 1) continue;
		const mp4 = mp4De.get(x.s.sc);
		if (!mp4) continue;
		const cajas = x.c.subtipo === 'capa' ? [{x: x.c.caja.x0, y: x.c.caja.y0, w: x.c.caja.x1 - x.c.caja.x0, h: x.c.caja.y1 - x.c.caja.y0, color: 'magenta@0.9'}] : [];
		const jpeg = cuadroJpeg(mp4, (x.c.desde + x.c.hasta) / 2, {ancho: 216, cajas});
		if (!jpeg) continue;
		porReelI.set(x.s.sc, 1);
		celdas4.push({jpeg, ancho: 216, alto: 384, etiqueta: `${x.s.sc} · ${x.c.subtipo === 'capa' ? 'en tarjeta' : 'pantalla completa'}`});
	}
	await hacer('inserts.jpg', 'Inserts', `Inserts (${num('inserts.pct_pantalla_completa') ?? 'N/A'} % a pantalla completa; en tarjeta con su caja en magenta).`, celdas4, 4);

	// 5) Zona UI y cabeza: un cuadro con la zona de tus capas (verde) y la franja (cian).
	const celdas5: Celda[] = [];
	const z = {a: num('zona_ui.arriba'), b: num('zona_ui.abajo'), i: num('zona_ui.izquierda'), d: num('zona_ui.derecha')};
	for (const s of recientes.filter((x) => x.capas.some((c) => c.clase === 'tarjeta')).slice(0, 3)) {
		const c = s.capas.find((k) => k.clase === 'tarjeta')!;
		const cajas = [] as Array<{x: number; y: number; w: number; h: number; color: string}>;
		if (z.a !== null && z.b !== null && z.i !== null && z.d !== null) cajas.push({x: z.i, y: z.a, w: z.d - z.i, h: z.b - z.a, color: 'lime@0.9'});
		cajas.push({x: c.caja.x0, y: c.caja.y0, w: c.caja.x1 - c.caja.x0, h: c.caja.y1 - c.caja.y0, color: 'orange@0.9'});
		const jpeg = cuadroJpeg(mp4De.get(s.sc)!, (c.desde + c.hasta) / 2, {ancho: 270, cajas});
		if (jpeg) celdas5.push({jpeg, ancho: 270, alto: 480, etiqueta: `${s.sc} · zona UI y una tarjeta`});
	}
	await hacer('zona-ui.jpg', 'Zona de tus capas (verde) y una tarjeta (naranja)', `La envolvente de tus capas en reels recientes: arriba ${z.a ?? 'N/A'}, abajo ${z.b ?? 'N/A'}, lados ${z.i ?? 'N/A'}–${z.d ?? 'N/A'} px.`, celdas5, 3);

	// 6) Tipografía: tu recorte real y la candidata elegida dibujada con el mismo texto.
	const tipo = leerSiExiste<{muestras: Array<{capa: string; reel: string; id: string; texto: string; png: string}>}>(RUTA_TIPOGRAFIA);
	const celdas6: Celda[] = [];
	if (tipo) {
		const {CANDIDATAS} = await import('../../src/estilo/fuentes.ts');
		for (const capa of ['subtitulos', 'titular', 'tarjetas']) {
			const m = tipo.muestras.find((x) => x.capa === capa);
			const elegida = g(`tipografia.${capa}.candidata`) as {valor?: unknown} | undefined;
			const peso = g(`tipografia.${capa}.peso`) as {valor?: unknown} | undefined;
			if (!m || typeof elegida?.valor !== 'string' || typeof peso?.valor !== 'number') continue;
			const png = join(RAIZ, m.png);
			if (!existsSync(png)) continue;
			const real = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'scale=480:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', '-'], {maxBuffer: 1 << 24});
			if (real.status !== 0) continue;
			const dims = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png]);
			const [w0, h0] = String(dims.stdout).trim().split(',').map(Number);
			const alto = Math.max(20, Math.round((h0 * 480) / (w0 || 480)));
			const nombreCapa = ({subtitulos: 'subtítulos', titular: 'titular', tarjetas: 'tarjetas'} as Record<string, string>)[capa] ?? capa;
			celdas6.push({jpeg: real.stdout as Buffer, ancho: 480, alto, etiqueta: `${nombreCapa}: tu reel ${m.reel}`});
			const id = elegida.valor as 'tiktok-sans' | 'instrument-sans' | 'inter';
			const ruta = CANDIDATAS[id]?.archivos[peso.valor]?.ruta;
			if (!ruta) continue;
			const svg = await textoDibujado(ruta, m.texto, 480, alto, capa === 'tarjetas' ? 'caja' : 'contorno');
			const par = g(`tipografia.${capa}.parecido`) as {valor?: unknown} | undefined;
			if (svg) celdas6.push({jpeg: svg, ancho: 480, alto, etiqueta: `${nombreCapa}: ${CANDIDATAS[id].nombre} ${peso.valor} · IoU ${String(par?.valor ?? 'N/A')}`});
		}
	}
	await hacer('tipografia.jpg', 'Tipografía: tu recorte (izq.) y la candidata elegida (der.)', 'Cada par: un recorte real de tus reels y la candidata con más parecido dibujada con el mismo texto (blanco con contorno negro, o negro en caja blanca para las tarjetas).', celdas6, 2);

	escribirJsonAtomico(join(DIR_INFORME, 'hojas.json'), {generado_en: new Date().toISOString(), hojas: hojas.map(({bytes, ...h}) => ({...h, kb: Math.round(bytes / 1024)}))});
	return hojas.map((h) => ({archivo: h.archivo, bytes: h.bytes}));
}

/** Un texto dibujado con una candidata en una celda (JPEG): blanco con contorno negro sobre gris, o negro en caja blanca. */
async function textoDibujado(ruta: string, texto: string, ancho: number, alto: number, estilo: 'contorno' | 'caja' = 'contorno'): Promise<Buffer | null> {
	const {abrirFuente} = await import('../lib/texto-ancho.ts');
	const {Resvg} = await import('@resvg/resvg-js');
	const fuente = abrirFuente(join(RAIZ, ruta));
	const prueba = pathDeTexto(fuente, texto, 100);
	const anchoPrueba = prueba.x1 - prueba.x0;
	const altoPrueba = prueba.y1 - prueba.y0;
	if (!(anchoPrueba > 0 && altoPrueba > 0)) return null;
	const tam = Math.min((100 * (ancho - 40)) / anchoPrueba, (100 * (alto - 16)) / altoPrueba);
	const p = pathDeTexto(fuente, texto, tam);
	const tx = (ancho - (p.x1 - p.x0)) / 2 - p.x0;
	const ty = (alto - (p.y1 - p.y0)) / 2 - p.y0;
	const trazo = estilo === 'caja' ? 'fill="#000"' : `fill="#fff" stroke="#000" stroke-width="${Math.max(2, tam * 0.08).toFixed(1)}" stroke-linejoin="round" paint-order="stroke fill"`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}"><rect width="100%" height="100%" fill="${estilo === 'caja' ? '#fefbff' : '#7a7a7a'}"/><path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)})" d="${p.d}" ${trazo}/></svg>`;
	const png = new Resvg(svg, {fitTo: {mode: 'original'}}).render().asPng();
	const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', '-'], {input: png, maxBuffer: 1 << 24});
	return r.status === 0 ? (r.stdout as Buffer) : null;
}

/** Hojas de los 3 virales del top para revisarlas a ojo (out/aprender/virales/<sc>.jpg, 12 cuadros cada una). */
export async function hojasVirales(reels: readonly ReelConjunto[], avisar: (m: string) => void): Promise<string[]> {
	const top = reels.filter((r) => r.grupo === 'top' && r.rank !== null && r.mp4 && existsSync(r.mp4)).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).slice(0, 3);
	const rutas: string[] = [];
	for (const r of top) {
		const dur = r.duracion_s ?? 30;
		const celdas: Celda[] = [];
		for (let i = 0; i < 12; i++) {
			const t = Math.min(dur - 0.1, (dur * (i + 0.5)) / 12);
			const jpeg = cuadroJpeg(r.mp4, t, {ancho: 180});
			if (jpeg) celdas.push({jpeg, ancho: 180, alto: 320, etiqueta: `t=${t.toFixed(1)} s`});
		}
		const ruta = join(DIR_TRABAJO, 'virales', `${r.shortCode}.jpg`);
		await componerHoja(ruta, `#${r.rank} ${r.shortCode} (puntaje ${r.puntaje})`, celdas, 6);
		rutas.push(ruta);
	}
	if (rutas.length) avisar(`Hojas de los virales para revisar a ojo: ${rutas.map((x) => relative(RAIZ, x)).join(', ')}`);
	return rutas;
}

if (esPrincipal(import.meta.url)) void correr(main);

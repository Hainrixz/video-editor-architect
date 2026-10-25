// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * emparejar.ts — busca pares crudo ↔ reel publicado para las pruebas A/B (Fase 0).
 *
 * Uso: npx tsx herramientas/emparejar.ts [--rehacer]
 *   --rehacer   vuelve a extraer el audio y a transcribir aunque ya esté en pruebas/fixtures/emparejar/
 *
 * 1. Crudos: ~/Downloads/IMG_*.MOV de ≥ 55 s (ffprobe: duración y tags.creation_time).
 * 2. Reels: une <carpeta yt-dlp>/data/raw/*.json y <carpeta Apify>/reels-200.json (creador.json → corpus),
 *    solo los de ownerUsername = creador.json → handle (shortCode, timestamp, videoPlayCount).
 *    El mp4 publicado local es <carpeta yt-dlp>/data/videos/<shortCode>.mp4, si existe.
 * 3. Fecha: el reel se publicó entre 0 y 6 h después del creation_time del crudo.
 * 4. Texto: whisper-cli large-v3 (-l es, sin DTW, -otxt) sobre los primeros 60 s de cada lado,
 *    con el audio a 16 kHz mono en pruebas/fixtures/emparejar/. similitud = 1 − WER con el reel como
 *    referencia, sobre palabras normalizadas (minúsculas, sin acentos ni puntuación). Se acepta con ≥ 0.6.
 * 5. Uno a uno: si un reel o un crudo cae en dos candidatos aceptables, se queda el de mayor similitud.
 *
 * Tus carpetas se leen en solo lectura: nada se mueve, se copia ni se borra. Lo generado va a
 * pruebas/fixtures/emparejar/ y a pruebas/pares.json. No usa red ni gasta nada.
 * Sale con 0 si queda al menos 1 par aceptado y con 2 si no queda ninguno (entonces te pido uno).
 */
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {expandirRuta, leerCreador, requerirHandle} from './lib/creador.ts';
import {correr, esPrincipal, fallo} from './lib/fallo';
import {rutaModeloWhisper} from './lib/plataforma';

const ejecutarArchivo = promisify(execFile);

const RAIZ = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOME = homedir();

// Todo lo personal sale de creador.json (corpus y whisper_modelo); lo que no dice queda en una carpeta que no existe
// y main lo reporta con código 2.
const CREADOR = leerCreador();
const SIN_CARPETA = join(RAIZ, '.sin-carpeta-en-creador-json');
const primera = (l: readonly string[]): string | null => (l[0] ? expandirRuta(l[0]) : null);
const YTDLP = primera(CREADOR.corpus.carpetas_ytdlp);
const APIFY = primera(CREADOR.corpus.carpetas_apify);
const CARPETA_CRUDOS = primera(CREADOR.corpus.crudos) ?? join(HOME, 'Downloads');
const CARPETA_RAW = YTDLP ? join(YTDLP, 'data', 'raw') : SIN_CARPETA;
const ARCHIVO_APIFY = APIFY ? join(APIFY, 'reels-200.json') : SIN_CARPETA;
const CARPETA_VIDEOS = YTDLP ? join(YTDLP, 'data', 'videos') : SIN_CARPETA;
/**
 * Modelo de whisper large-v3 (supuesto 8: whisper-cpp 1.8.4): EDITOR_WHISPER_MODELO manda; si no, creador.json →
 * whisper_modelo; si no, la carpeta de modelos (EDITOR_MODELOS, lib/plataforma.ts → rutaModeloWhisper).
 */
const MODELO_WHISPER = CREADOR.whisper_modelo && !process.env.EDITOR_WHISPER_MODELO?.trim() ? expandirRuta(CREADOR.whisper_modelo) : rutaModeloWhisper('whisper');
const DUENO = CREADOR.handle;

const SALIDA_AUDIO = join(RAIZ, 'pruebas', 'fixtures', 'emparejar');
const SALIDA_PARES = join(RAIZ, 'pruebas', 'pares.json');

export const DURACION_MINIMA_S = 55;
export const VENTANA_HORAS = 6;
export const SEGUNDOS_TEXTO = 60;
export const UMBRAL_SIMILITUD = 0.6;
/** Sin --dtw ni --vad: aquí solo importa el texto, no los tiempos por palabra. */
const ARGS_WHISPER = ['-l', 'es', '-otxt', '-np'] as const;

export type Crudo = {ruta: string; nombre: string; duracion_s: number; creado_en: string};
export type Reel = {shortCode: string; publicado_en: string; plays: number | null};
export type Candidato = {crudo: Crudo; reel: Reel; delta_horas: number};

export type Par = {
	/** Ruta absoluta del MOV original (solo lectura). */
	crudo: string;
	shortCode: string;
	/** Ruta absoluta del mp4 publicado en local, o null si no está. */
	publicado_mp4: string | null;
	delta_horas: number;
	/** 1 − WER (referencia: el reel), acotada a [0, 1]; null si no hubo texto para comparar. */
	similitud: number | null;
	/** Solo `similitud` ≥ 0.6 (y uno a uno) acepta un par. */
	aceptado: boolean;
	motivo: string;
	wer: number | null;
	/** Diagnóstico: el crudo contra el mejor inicio del reel (ver similitudTramo). No cambia `aceptado`. */
	similitud_tramo: number | null;
	palabras_tramo: number | null;
	/** true si no se acepta con la regla de 60 s pero el texto calca el inicio del reel: revísalo. */
	probable: boolean;
	creado_en: string;
	publicado_en: string;
	plays: number | null;
	duracion_crudo_s: number;
	palabras_reel: number | null;
	palabras_crudo: number | null;
};

// ───────────────────────── funciones puras ─────────────────────────

/** Minúsculas, sin acentos ni puntuación. Quita anotaciones de whisper como [Música] o (risas). */
export function normalizarPalabras(texto: string): string[] {
	return texto
		.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);
}

/** Distancia de edición por palabras: sustituciones + borrados + inserciones. */
export function distanciaPalabras(referencia: string[], hipotesis: string[]): number {
	let previa = Array.from({length: hipotesis.length + 1}, (_, j) => j);
	for (let i = 1; i <= referencia.length; i++) {
		const actual = [i];
		for (let j = 1; j <= hipotesis.length; j++) {
			const cambio = referencia[i - 1] === hipotesis[j - 1] ? 0 : 1;
			actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + cambio);
		}
		previa = actual;
	}
	return previa[hipotesis.length];
}

/** WER de la hipótesis contra la referencia; null si la referencia no tiene palabras. */
export function wer(referencia: string[], hipotesis: string[]): number | null {
	return referencia.length === 0 ? null : distanciaPalabras(referencia, hipotesis) / referencia.length;
}

/** similitud = 1 − WER, acotada a [0, 1] (la WER pasa de 1 si sobran muchas palabras). */
export function similitudTexto(referencia: string[], hipotesis: string[]): number | null {
	const w = wer(referencia, hipotesis);
	return w === null ? null : Math.max(0, 1 - w);
}

/**
 * Diagnóstico (no decide nada): 1 − WER de todo el texto del crudo contra el mejor INICIO del reel.
 * Sirve para ver cuándo la ventana fija de 60 s es la que falla: si el crudo trae pausas y tomas
 * repetidas, sus primeros 60 s solo cubren el arranque del reel y la WER normal se dispara por
 * borrados aunque sea el mismo video. `palabras` = cuántas palabras del reel cubre ese inicio.
 */
export function similitudTramo(referencia: string[], hipotesis: string[]): {similitud: number | null; palabras: number} {
	if (referencia.length === 0 || hipotesis.length === 0) return {similitud: null, palabras: 0};
	let previa = Array.from({length: hipotesis.length + 1}, (_, j) => j);
	let mejor = {palabras: 0, wer: Number.POSITIVE_INFINITY};
	for (let i = 1; i <= referencia.length; i++) {
		const actual = [i];
		for (let j = 1; j <= hipotesis.length; j++) {
			const cambio = referencia[i - 1] === hipotesis[j - 1] ? 0 : 1;
			actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + cambio);
		}
		const werPrefijo = actual[hipotesis.length] / i;
		if (werPrefijo < mejor.wer) mejor = {palabras: i, wer: werPrefijo};
		previa = actual;
	}
	return {similitud: Math.max(0, 1 - mejor.wer), palabras: mejor.palabras};
}

/** Une las capturas por shortCode, solo tuyas. Plays: el mayor visto (la captura más reciente). */
export function unirReels(lotes: unknown[][], dueno = DUENO): Reel[] {
	const porCodigo = new Map<string, Reel>();
	for (const lote of lotes) {
		for (const item of lote) {
			if (!item || typeof item !== 'object') continue;
			const r = item as {ownerUsername?: unknown; shortCode?: unknown; timestamp?: unknown; videoPlayCount?: unknown};
			if (r.ownerUsername !== dueno || typeof r.shortCode !== 'string' || typeof r.timestamp !== 'string') continue;
			const ms = Date.parse(r.timestamp);
			if (Number.isNaN(ms)) continue;
			const plays = typeof r.videoPlayCount === 'number' ? r.videoPlayCount : null;
			const previo = porCodigo.get(r.shortCode)?.plays ?? null;
			porCodigo.set(r.shortCode, {
				shortCode: r.shortCode,
				publicado_en: new Date(ms).toISOString(),
				plays: previo === null ? plays : plays === null ? previo : Math.max(previo, plays),
			});
		}
	}
	return [...porCodigo.values()];
}

/** Reels publicados entre 0 y `ventanaHoras` después de grabado cada crudo. */
export function candidatosPorFecha(crudos: Crudo[], reels: Reel[], ventanaHoras = VENTANA_HORAS): Candidato[] {
	const lista: Candidato[] = [];
	for (const crudo of crudos) {
		const grabado = Date.parse(crudo.creado_en);
		for (const reel of reels) {
			const delta = (Date.parse(reel.publicado_en) - grabado) / 3_600_000;
			if (delta >= 0 && delta <= ventanaHoras) lista.push({crudo, reel, delta_horas: delta});
		}
	}
	return lista.sort((a, b) => a.crudo.nombre.localeCompare(b.crudo.nombre) || a.delta_horas - b.delta_horas);
}

type ParaDecidir = {
	crudo: string;
	shortCode: string;
	similitud: number | null;
	delta_horas: number;
	motivo?: string;
	similitud_tramo?: number | null;
	palabras_tramo?: number | null;
};

/** Para marcar "probable" el tramo común tiene que cubrir al menos estas palabras del reel. */
export const PALABRAS_MINIMAS_TRAMO = 30;

/**
 * Acepta los pares con similitud ≥ umbral, uno a uno: de mayor a menor similitud (empate: menor delta),
 * un crudo y un reel solo entran en un par aceptado.
 * Aparte, marca `probable` (sin aceptarlo) al que no pasa la regla de 60 s pero cuyo tramo común sí pasa
 * el umbral con ≥ 30 palabras, siempre que ni su crudo ni su reel ya estén en un par aceptado.
 */
export function decidir(
	items: ParaDecidir[],
	umbral = UMBRAL_SIMILITUD,
): {aceptado: boolean; motivo: string; probable: boolean}[] {
	const decisiones = items.map((it) => ({aceptado: false, motivo: it.motivo ?? '', probable: false}));
	// Puntaje efectivo: el mejor entre los 60 s fijos y el tramo que calca el inicio del reel
	// (con ≥30 palabras). Los crudos traen pausas y tomas repetidas, así que 60 s fijos se quedan cortos:
	// en las pruebas, los pares reales dieron 0.76–0.98 por tramo y los falsos ≤0.25.
	const puntaje = (it: ParaDecidir): number => {
		const fijo = it.similitud ?? -1;
		const tramo = (it.palabras_tramo ?? 0) >= PALABRAS_MINIMAS_TRAMO ? (it.similitud_tramo ?? -1) : -1;
		return Math.max(fijo, tramo);
	};
	const orden = items
		.map((_, i) => i)
		.filter((i) => puntaje(items[i]) >= umbral)
		.sort((a, b) => puntaje(items[b]) - puntaje(items[a]) || items[a].delta_horas - items[b].delta_horas);
	const reelTomado = new Map<string, string>();
	const crudoTomado = new Map<string, string>();
	for (const i of orden) {
		const it = items[i];
		const conReel = reelTomado.get(it.shortCode);
		const conCrudo = crudoTomado.get(it.crudo);
		if (conReel) {
			decisiones[i].motivo = `el texto coincide, pero el reel ya quedó con ${conReel}, que se parece más`;
			continue;
		}
		if (conCrudo) {
			decisiones[i].motivo = `el texto coincide, pero el crudo ya quedó con ${conCrudo}, que se parece más`;
			continue;
		}
		reelTomado.set(it.shortCode, it.crudo);
		crudoTomado.set(it.crudo, it.shortCode);
		const porTramo = (it.similitud ?? -1) < umbral;
		decisiones[i] = {
			aceptado: true,
			motivo: porTramo
				? `fecha y texto coinciden (por tramo: ${(it.similitud_tramo ?? 0).toFixed(2)} en ${it.palabras_tramo ?? 0} palabras)`
				: 'fecha y texto coinciden',
			probable: false,
		};
	}
	items.forEach((it, i) => {
		if (decisiones[i].aceptado || decisiones[i].motivo) return;
		if (it.similitud === null) {
			decisiones[i].motivo = 'sin texto para comparar';
			return;
		}
		const tramo = it.similitud_tramo ?? null;
		const palabras = it.palabras_tramo ?? 0;
		const libre = !reelTomado.has(it.shortCode) && !crudoTomado.has(it.crudo);
		if (tramo !== null && tramo >= umbral && palabras >= PALABRAS_MINIMAS_TRAMO && libre) {
			decisiones[i].probable = true;
			decisiones[i].motivo =
				`no pasa con 60 s fijos (${it.similitud.toFixed(2)} < ${umbral}), pero los primeros 60 s del crudo calcan ` +
				`el inicio del reel (${tramo.toFixed(2)} en ${palabras} palabras): probable par, revísalo`;
			return;
		}
		decisiones[i].motivo = `el texto no coincide (${it.similitud.toFixed(2)} < ${umbral})`;
	});
	return decisiones;
}

// ───────────────────────── E/S ─────────────────────────

function corta(ruta: string): string {
	return ruta.startsWith(HOME + '/') ? '~' + ruta.slice(HOME.length) : ruta;
}

function nombreCrudo(ruta: string): string {
	return ruta.split('/').pop()!.replace(/\.mov$/i, '');
}

function redondear(x: number | null, decimales: number): number | null {
	if (x === null) return null;
	const f = 10 ** decimales;
	return Math.round(x * f) / f;
}

/** Candado: todo lo que escribimos queda dentro del proyecto (tus originales son solo lectura). */
function asegurarDentroDelProyecto(ruta: string): void {
	if (!resolve(ruta).startsWith(RAIZ + sep)) {
		throw fallo('escribir un archivo de trabajo', `${ruta} queda fuera del proyecto`, 'avísame: es un error del emparejador', 1);
	}
}

async function enParalelo<T, R>(items: T[], limite: number, fn: (x: T) => Promise<R>): Promise<R[]> {
	const resultados = new Array<R>(items.length);
	let siguiente = 0;
	const trabajador = async () => {
		while (siguiente < items.length) {
			const i = siguiente++;
			resultados[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({length: Math.min(limite, items.length)}, trabajador));
	return resultados;
}

async function sondear(ruta: string): Promise<{duracion_s: number; creado_en: string | null} | null> {
	try {
		const {stdout} = await ejecutarArchivo('ffprobe', [
			'-v', 'error',
			'-show_entries', 'format=duration:format_tags=creation_time',
			'-of', 'json',
			ruta,
		]);
		const datos = JSON.parse(stdout) as {format?: {duration?: string; tags?: {creation_time?: string}}};
		const creado = datos.format?.tags?.creation_time;
		return {
			duracion_s: Number(datos.format?.duration ?? Number.NaN),
			creado_en: creado && !Number.isNaN(Date.parse(creado)) ? new Date(creado).toISOString() : null,
		};
	} catch {
		return null;
	}
}

/**
 * Texto de los primeros 60 s de un video: audio 16 kHz mono → whisper-cli.
 * Reutiliza lo ya transcrito si la fuente (tamaño y fecha) y los parámetros no cambiaron.
 */
async function textoInicio(fuente: string, base: string, rehacer: boolean): Promise<{texto: string; guardado: boolean}> {
	const wav = join(SALIDA_AUDIO, `${base}.wav`);
	const txt = join(SALIDA_AUDIO, `${base}.txt`);
	const meta = join(SALIDA_AUDIO, `${base}.meta.json`);
	for (const ruta of [wav, txt, meta]) asegurarDentroDelProyecto(ruta);
	const st = statSync(fuente);
	const firma = JSON.stringify({
		fuente,
		tamano: st.size,
		mtimeMs: st.mtimeMs,
		segundos: SEGUNDOS_TEXTO,
		modelo: MODELO_WHISPER,
		args: ARGS_WHISPER,
	});
	if (!rehacer && existsSync(txt) && existsSync(meta) && readFileSync(meta, 'utf8').trim() === firma) {
		return {texto: readFileSync(txt, 'utf8'), guardado: true};
	}
	await ejecutarArchivo('ffmpeg', [
		'-nostdin', '-hide_banner', '-v', 'error', '-y',
		'-t', String(SEGUNDOS_TEXTO), '-i', fuente,
		'-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
		wav,
	]);
	await ejecutarArchivo('whisper-cli', ['-m', MODELO_WHISPER, '-f', wav, ...ARGS_WHISPER, '-of', join(SALIDA_AUDIO, base)], {
		maxBuffer: 64 * 1024 * 1024,
	});
	const texto = readFileSync(txt, 'utf8');
	writeFileSync(meta, firma + '\n');
	return {texto, guardado: false};
}

function leerJson(ruta: string): unknown[] {
	const datos = JSON.parse(readFileSync(ruta, 'utf8')) as unknown;
	return Array.isArray(datos) ? datos : [];
}

// ───────────────────────── principal ─────────────────────────

async function main(): Promise<void> {
	const rehacer = process.argv.includes('--rehacer');
	console.log('Emparejar · crudo ↔ reel publicado\n');
	requerirHandle(CREADOR, 'emparejar crudos con reels');
	if (!existsSync(CARPETA_CRUDOS)) {
		throw fallo('buscar tus crudos', `no existe ${corta(CARPETA_CRUDOS)}`, 'dime en qué carpeta están tus IMG_*.MOV', 2);
	}
	if (!existsSync(MODELO_WHISPER)) {
		throw fallo(
			'confirmar los pares por texto',
			`no encuentro el modelo de whisper en ${corta(MODELO_WHISPER)}`,
			'corre npx tsx herramientas/doctor.ts y arregla lo marcado con ✖',
			2,
		);
	}

	// 1. Crudos de ≥ 55 s
	const movs = readdirSync(CARPETA_CRUDOS).filter((n) => /^IMG_.*\.mov$/i.test(n)).sort();
	const sondeos = await enParalelo(movs, 8, (n) => sondear(join(CARPETA_CRUDOS, n)));
	const ilegibles = movs.filter((_, i) => sondeos[i] === null);
	const crudos: Crudo[] = [];
	const sinFecha: string[] = [];
	movs.forEach((n, i) => {
		const s = sondeos[i];
		if (!s || !(s.duracion_s >= DURACION_MINIMA_S)) return;
		if (!s.creado_en) {
			sinFecha.push(nombreCrudo(n));
			return;
		}
		const ruta = join(CARPETA_CRUDOS, n);
		crudos.push({ruta, nombre: nombreCrudo(n), duracion_s: s.duracion_s, creado_en: s.creado_en});
	});

	// 2. Reels tuyos
	const fuentesRaw = existsSync(CARPETA_RAW)
		? readdirSync(CARPETA_RAW).filter((n) => n.endsWith('.json')).sort().map((n) => join(CARPETA_RAW, n))
		: [];
	const fuentes = [...fuentesRaw, ...(existsSync(ARCHIVO_APIFY) ? [ARCHIVO_APIFY] : [])];
	if (fuentes.length === 0) {
		throw fallo(
			'leer tus reels publicados',
			`no hay JSON en ${corta(CARPETA_RAW)} ni ${corta(ARCHIVO_APIFY)}`,
			'dime dónde están los datos de tus reels',
			2,
		);
	}
	const reels = unirReels(fuentes.map(leerJson));

	// 3. Fecha
	const candidatos = candidatosPorFecha(crudos, reels);

	// 4. Texto (en serie: whisper usa la GPU completa)
	mkdirSync(SALIDA_AUDIO, {recursive: true});
	const palabrasPorFuente = new Map<string, string[]>();
	const palabrasDe = async (fuente: string, base: string): Promise<string[]> => {
		const hecho = palabrasPorFuente.get(fuente);
		if (hecho) return hecho;
		const {texto, guardado} = await textoInicio(fuente, base, rehacer);
		console.log(`  ${guardado ? 'texto ya guardado' : 'transcribí'}: primeros ${SEGUNDOS_TEXTO} s de ${base}`);
		const palabras = normalizarPalabras(texto);
		palabrasPorFuente.set(fuente, palabras);
		return palabras;
	};

	type Medido = Candidato & {
		mp4: string | null;
		similitud: number | null;
		wer: number | null;
		tramo: {similitud: number | null; palabras: number} | null;
		nRef: number | null;
		nHip: number | null;
		motivo?: string;
	};
	const sinTexto = {similitud: null, wer: null, tramo: null, nRef: null, nHip: null};
	const medidos: Medido[] = [];
	for (const c of candidatos) {
		const posible = join(CARPETA_VIDEOS, `${c.reel.shortCode}.mp4`);
		const mp4 = existsSync(posible) ? posible : null;
		if (!mp4) {
			medidos.push({...c, mp4, ...sinTexto, motivo: `el reel publicado no está en local (falta ${corta(posible)})`});
			continue;
		}
		try {
			const referencia = await palabrasDe(mp4, `reel-${c.reel.shortCode}`);
			const hipotesis = await palabrasDe(c.crudo.ruta, `crudo-${c.crudo.nombre}`);
			const motivo = referencia.length === 0 ? 'el reel no tiene voz en sus primeros 60 s' : undefined;
			medidos.push({
				...c,
				mp4,
				similitud: similitudTexto(referencia, hipotesis),
				wer: wer(referencia, hipotesis),
				tramo: similitudTramo(referencia, hipotesis),
				nRef: referencia.length,
				nHip: hipotesis.length,
				motivo,
			});
		} catch (error) {
			const causa = error instanceof Error ? error.message.split('\n')[0] : String(error);
			medidos.push({...c, mp4, ...sinTexto, motivo: `no pude transcribir (${causa})`});
		}
	}

	// 5. Uno a uno
	const decisiones = decidir(
		medidos.map((m) => ({
			crudo: m.crudo.nombre,
			shortCode: m.reel.shortCode,
			similitud: m.similitud,
			delta_horas: m.delta_horas,
			motivo: m.motivo,
			similitud_tramo: m.tramo?.similitud ?? null,
			palabras_tramo: m.tramo?.palabras ?? null,
		})),
	);
	const pares: Par[] = medidos.map((m, i) => ({
		crudo: m.crudo.ruta,
		shortCode: m.reel.shortCode,
		publicado_mp4: m.mp4,
		delta_horas: redondear(m.delta_horas, 2)!,
		similitud: redondear(m.similitud, 3),
		aceptado: decisiones[i].aceptado,
		motivo: decisiones[i].motivo,
		wer: redondear(m.wer, 3),
		similitud_tramo: redondear(m.tramo?.similitud ?? null, 3),
		palabras_tramo: m.tramo?.palabras ?? null,
		probable: decisiones[i].probable,
		creado_en: m.crudo.creado_en,
		publicado_en: m.reel.publicado_en,
		plays: m.reel.plays,
		duracion_crudo_s: redondear(m.crudo.duracion_s, 2)!,
		palabras_reel: m.nRef,
		palabras_crudo: m.nHip,
	}));
	asegurarDentroDelProyecto(SALIDA_PARES);
	writeFileSync(SALIDA_PARES, JSON.stringify(pares, null, '\t') + '\n');

	// Resumen
	const aceptados = pares.filter((p) => p.aceptado);
	const conCandidato = new Set(candidatos.map((c) => c.crudo.nombre));
	const sinReel = crudos.filter((c) => !conCandidato.has(c.nombre)).map((c) => c.nombre);
	console.log(`\nCrudos: ${crudos.length} IMG_*.MOV de ≥ ${DURACION_MINIMA_S} s (de ${movs.length} en ${corta(CARPETA_CRUDOS)})`);
	console.log(`Reels tuyos: ${reels.length} únicos (${fuentes.length} archivos JSON)`);
	console.log(`Candidatos por fecha (0–${VENTANA_HORAS} h después de grabar): ${candidatos.length}\n`);
	for (const p of pares) {
		const sim = p.similitud === null ? '   —  ' : p.similitud.toFixed(3);
		console.log(
			`  ${p.aceptado ? '✔' : '✖'} ${nombreCrudo(p.crudo).padEnd(9)} → ${p.shortCode.padEnd(12)} +${p.delta_horas.toFixed(2)} h  similitud ${sim}  ${p.motivo}`,
		);
	}
	const probables = pares.filter((p) => p.probable);
	console.log(`\nPares aceptados: ${aceptados.length} de ${pares.length} → pruebas/pares.json`);
	if (probables.length) {
		console.log(
			`Probables pares que la regla de 60 s no acepta (revísalos): ${probables.map((p) => `${nombreCrudo(p.crudo)} → ${p.shortCode}`).join(', ')}`,
		);
	}
	if (sinReel.length) console.log(`Crudos sin reel en la ventana: ${sinReel.join(', ')}`);
	if (sinFecha.length) console.log(`Crudos sin creation_time (no se pueden emparejar por fecha): ${sinFecha.join(', ')}`);
	if (ilegibles.length) console.log(`MOV que ffprobe no pudo leer: ${ilegibles.join(', ')}`);

	if (aceptados.length === 0) {
		throw fallo(
			'confirmar ningún par crudo ↔ reel',
			`de ${candidatos.length} candidatos por fecha, ninguno pasó la similitud de ${UMBRAL_SIMILITUD}`,
			'dime 1 crudo de ~/Downloads y el shortCode de su reel publicado',
			2,
		);
	}
}

if (esPrincipal(import.meta.url)) void correr(main);

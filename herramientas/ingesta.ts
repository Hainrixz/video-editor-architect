// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Ingesta de un crudo (etapa 1 de /editar).
 *
 *   npx tsx herramientas/ingesta.ts <ruta-crudo> [--slug AAAA-MM-DD-tema] [--forzar]
 *
 * 1. Sondea el crudo con ffprobe: rotación, fps real y nominal, color y audio.
 * 2. Si es HDR (o no trae audio) se detiene con código 2: te pregunto antes de seguir.
 * 3. Crea proyectos/<slug>/ y saca audio16k.wav (-vn -ac 1 -ar 16000 -c:a pcm_s16le) para transcribir.
 * 4. Registra en manifest.json la ruta del original, su sha256, tamaño y mtime.
 *
 * El original es de solo lectura: no se copia, no se mueve y nunca es salida de ffmpeg.
 * Si la etapa ya está vigente (mismo original, mismos parámetros, wav en su lugar) no se rehace; --forzar la rehace.
 * Sin --slug, el slug sale de la fecha de grabación y el nombre del archivo (p. ej. 2026-08-27-img-3905).
 */
import {mkdirSync, realpathSync, renameSync, rmSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {correr, fallo} from './lib/fallo.ts';
import {correrFfmpeg, ffprobeJson, revisarApto, sondear, type Sondeo} from './lib/ffprobe.ts';
import {
	DIR_PROYECTOS,
	RAIZ,
	actualizarManifest,
	dirProyecto,
	etapaVigente,
	hashearArchivo,
	huellaOriginal,
	leerManifest,
	registrarEtapa,
	rutaSalidaSegura,
	validarSlug,
	type ArchivoHash,
	type HuellaOriginal,
} from './lib/manifest.ts';

export const NOMBRE_WAV = 'audio16k.wav';

const USO = 'npx tsx herramientas/ingesta.ts <ruta-crudo> [--slug AAAA-MM-DD-tema] [--forzar]';

/** Parámetros de la etapa (si cambian, la ingesta deja de estar vigente y se rehace). */
export function parametrosIngesta(indiceAudio: number): Record<string, unknown> {
	return {
		version: 1,
		audio16k: {stream: indiceAudio, filtro: 'aresample=async=1:first_pts=0', canales: 1, muestreo: 16000, codec: 'pcm_s16le'},
	};
}

/**
 * Argumentos de ffmpeg para audio16k.wav.
 * `aresample=async=1:first_pts=0` rellena con silencio si el audio arranca después del video, así el wav
 * queda en la misma línea de tiempo que usa base.ts (los tiempos de la transcripción caen en su lugar).
 * bitexact: el mismo original da el mismo wav byte por byte (y el mismo sha256 en el manifest).
 */
export function argumentosAudio16k(original: string, indiceAudio: number, salida: string): string[] {
	return [
		'-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
		'-i', original,
		'-map', `0:${indiceAudio}`,
		'-vn',
		'-af', 'aresample=async=1:first_pts=0',
		'-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
		'-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
		'-f', 'wav',
		salida,
	];
}

const dosDigitos = (n: number): string => String(n).padStart(2, '0');
const fechaLocal = (d: Date): string => `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}`;

/** Fecha de grabación AAAA-MM-DD: primero la local del iPhone, luego creation_time (UTC → hora de esta Mac). */
export function fechaDeGrabacion(sondeo: Sondeo): string | null {
	if (sondeo.creationTimeLocal && /^\d{4}-\d{2}-\d{2}/.test(sondeo.creationTimeLocal)) return sondeo.creationTimeLocal.slice(0, 10);
	if (sondeo.creationTime) {
		const fecha = new Date(sondeo.creationTime);
		if (!Number.isNaN(fecha.getTime())) return fechaLocal(fecha);
	}
	return null;
}

/** Slug sugerido: <fecha de grabación>-<nombre del archivo en minúsculas>, p. ej. 2026-08-27-img-3905. */
export function slugSugerido(sondeo: Sondeo, ruta: string, respaldo: Date): string {
	const fecha = fechaDeGrabacion(sondeo) ?? fechaLocal(respaldo);
	const tema =
		basename(ruta, extname(ruta))
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'crudo';
	return `${fecha}-${tema}`;
}

/** Revisa que el wav salió como se pidió (16 kHz, mono, PCM 16) y que dura lo mismo que el audio original. */
async function verificarWav(ruta: string, sondeo: Sondeo): Promise<number> {
	const crudo = await ffprobeJson(ruta);
	const a = crudo.streams?.find((s) => s.codec_type === 'audio');
	const duracion = Number(a?.duration ?? crudo.format?.duration ?? NaN);
	const esperada = sondeo.audio?.duracion ?? sondeo.duracion;
	const problemas: string[] = [];
	if (!a) problemas.push('no trae audio');
	else {
		if (a.codec_name !== 'pcm_s16le') problemas.push(`códec ${a.codec_name}`);
		if (Number(a.sample_rate) !== 16000) problemas.push(`${a.sample_rate} Hz`);
		if (a.channels !== 1) problemas.push(`${a.channels} canales`);
	}
	if (!Number.isFinite(duracion) || Math.abs(duracion - esperada) > 0.25) {
		problemas.push(`dura ${Number.isFinite(duracion) ? duracion.toFixed(3) : '?'} s y el audio original ${esperada.toFixed(3)} s`);
	}
	if (problemas.length > 0) {
		throw fallo(`verificar ${NOMBRE_WAV}`, problemas.join(', '), 'revisa proyectos/_logs/fallos.log y avísame', 1, {ruta, crudo});
	}
	return duracion;
}

export type ResultadoIngesta = {
	slug: string;
	dir: string;
	sondeo: Sondeo;
	original: HuellaOriginal;
	wav: ArchivoHash;
	/** true si la etapa ya estaba vigente y no se rehizo. */
	reutilizada: boolean;
	segundos: number;
};

export type OpcionesIngesta = {ruta: string; slug?: string; forzar?: boolean; proyectos?: string};

export async function ingerir({ruta, slug, forzar = false, proyectos = DIR_PROYECTOS}: OpcionesIngesta): Promise<ResultadoIngesta> {
	const t0 = performance.now();
	const original = resolve(ruta);
	const nombre = basename(original);
	let datos;
	try {
		datos = statSync(original);
	} catch {
		throw fallo(`leer ${nombre}`, `no existe ${original}`, 'revisa la ruta (arrástrala a la terminal para copiarla exacta)', 2);
	}
	if (!datos.isFile()) throw fallo(`leer ${nombre}`, 'no es un archivo de video sino una carpeta', 'pásame la ruta del .MOV o .mp4', 2);

	const sondeo = await sondear(original);
	revisarApto(sondeo); // HDR o sin audio → código 2, antes de crear nada
	const indiceAudio = sondeo.audio!.indice;

	const elSlug = validarSlug(slug ?? slugSugerido(sondeo, original, datos.mtime));
	const dir = dirProyecto(elSlug, proyectos);
	const previo = leerManifest(elSlug, proyectos);
	const huella = await huellaOriginal(original);
	// Un slug es de un solo crudo. Con --forzar se registra el nuevo (p. ej. el mismo crudo re-exportado) y lo
	// que dependía del anterior deja de estar vigente solo, porque su sha256 ya no coincide.
	if (previo?.original && previo.original.sha256 !== huella.sha256 && !forzar) {
		throw fallo(
			`usar el slug ${elSlug}`,
			`ya pertenece a otro crudo (${basename(previo.original.ruta)}, con otro sha256)`,
			'elige otro --slug o, si es el mismo crudo re-exportado, repite con --forzar',
			2,
		);
	}

	const entradas: ArchivoHash[] = [{ruta: huella.ruta, sha256: huella.sha256, bytes: huella.tamano_bytes}];
	const parametros = parametrosIngesta(indiceAudio);
	if (!forzar && (await etapaVigente(elSlug, 'ingesta', entradas, parametros, proyectos))) {
		// Mismo contenido: si el original solo cambió de carpeta (o de mtime), se actualiza su ruta y listo.
		if (previo?.original?.ruta !== huella.ruta || previo?.original?.mtime !== huella.mtime) {
			actualizarManifest(
				elSlug,
				(m) => {
					m.original = huella;
					m.sondeo = sondeo;
				},
				proyectos,
			);
		}
		const wav = leerManifest(elSlug, proyectos)!.etapas.ingesta.salidas[0];
		return {slug: elSlug, dir, sondeo, original: huella, wav, reutilizada: true, segundos: (performance.now() - t0) / 1000};
	}

	mkdirSync(dir, {recursive: true});
	actualizarManifest(
		elSlug,
		(m) => {
			m.original = huella;
			m.sondeo = sondeo;
		},
		proyectos,
	);
	registrarEtapa(elSlug, 'ingesta', {estado: 'en-curso', entradas, parametros}, proyectos);

	const destino = rutaSalidaSegura(elSlug, NOMBRE_WAV, original, proyectos);
	const temporal = rutaSalidaSegura(elSlug, 'audio16k.tmp.wav', original, proyectos);
	let duracionWav: number;
	try {
		await correrFfmpeg(argumentosAudio16k(original, indiceAudio, temporal), {que: `sacar el audio de ${nombre}`});
		duracionWav = await verificarWav(temporal, sondeo);
		renameSync(temporal, destino);
	} catch (error) {
		rmSync(temporal, {force: true});
		registrarEtapa(elSlug, 'ingesta', {estado: 'fallida', entradas, parametros}, proyectos);
		throw error;
	}

	const wav = await hashearArchivo(destino, dir);
	const segundos = (performance.now() - t0) / 1000;
	registrarEtapa(
		elSlug,
		'ingesta',
		{estado: 'terminada', entradas, parametros, salidas: [wav], extra: {duracion_wav_s: duracionWav, duracion_proceso_s: Number(segundos.toFixed(2))}},
		proyectos,
	);
	return {slug: elSlug, dir, sondeo, original: huella, wav, reutilizada: false, segundos};
}

const conTilde = (ruta: string): string => (ruta.startsWith(homedir()) ? `~${ruta.slice(homedir().length)}` : ruta);
const tamano = (bytes: number): string =>
	bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} KB`;
const conSigno = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
const redondo = (n: number): string => (Math.abs(n - Math.round(n)) < 0.01 ? String(Math.round(n)) : n.toFixed(3));

export function resumenIngesta(r: ResultadoIngesta): string {
	const v = r.sondeo.video;
	const a = r.sondeo.audio!;
	const orientacion = v.altoVisible > v.anchoVisible ? 'vertical' : v.altoVisible < v.anchoVisible ? 'horizontal' : 'cuadrado';
	const rotacion = v.rotacion !== 0 ? ` con rotación ${conSigno(v.rotacion)}°` : '';
	const fps = `${redondo(v.fpsNominal)} fps nominales (${v.fpsReal.toFixed(3)} reales${v.vfr ? ', VFR' : ''})`;
	return [
		`Ingesta ${r.reutilizada ? 'ya estaba al día' : 'lista'}: ${r.slug}`,
		`  Original: ${conTilde(r.original.ruta)} · ${tamano(r.original.tamano_bytes)} · sha256 ${r.original.sha256.slice(0, 12)}… (no se copió ni se tocó)`,
		`  Video: ${v.codec.toUpperCase()} ${v.ancho}×${v.alto}${rotacion} → ${v.anchoVisible}×${v.altoVisible} ${orientacion} · ${fps} · SDR (${v.colorTransfer ?? 'sin dato de color'})`,
		`  Audio: ${a.codec.toUpperCase()} ${a.sampleRate} Hz · ${a.canales} canal${a.canales === 1 ? '' : 'es'} · ${r.sondeo.duracion.toFixed(2)} s`,
		`  Salida: ${relative(RAIZ, join(r.dir, NOMBRE_WAV))} (16 kHz mono) · ${tamano(r.wav.bytes ?? 0)} · ${r.segundos.toFixed(1)} s`,
	].join('\n');
}

/** Traduce los errores de parseArgs a una frase en español. */
export function errorDeArgumentos(error: unknown, uso: string): Error {
	const mensaje = error instanceof Error ? error.message : String(error);
	const desconocida = /Unknown option '([^']+)'/.exec(mensaje);
	const sinValor = /Option '([^']+?)(?: <value>)?' argument missing/.exec(mensaje);
	const porque = desconocida
		? `no conozco la opción ${desconocida[1]}`
		: sinValor
			? `a ${sinValor[1].split(',').pop()?.trim()} le falta su valor`
			: 'los argumentos no tienen la forma esperada';
	return fallo('leer los argumentos', porque, `usa ${uso}`, 2, mensaje);
}

async function main(): Promise<void> {
	let valores;
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({
			allowPositionals: true,
			options: {
				slug: {type: 'string'},
				forzar: {type: 'boolean', default: false},
				ayuda: {type: 'boolean', short: 'h', default: false},
			},
		}));
	} catch (error) {
		throw errorDeArgumentos(error, USO);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	if (posicionales.length !== 1) {
		throw fallo('empezar la ingesta', posicionales.length === 0 ? 'falta la ruta del crudo' : 'me pasaste más de una ruta', `usa ${USO}`, 2);
	}
	const resultado = await ingerir({ruta: posicionales[0], slug: valores.slug, forzar: valores.forzar});
	console.log(resumenIngesta(resultado));
}

/** Solo corre main si este archivo es el que se ejecutó (no al importarlo desde pruebas). */
function esEjecucionDirecta(): boolean {
	try {
		return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (esEjecucionDirecta()) await correr(main);

// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * render.ts — etapa 12 de /editar: el MP4 final listo para subir (o el borrador para QA).
 *
 *   npx tsx herramientas/render.ts <slug> [--version N] [--borrador] [--forzar]
 *
 * Final (sin --borrador):
 *  1. Valida proyectos/<slug>/edicion-vN.json con validar.ts (Remotion NO valida las props al renderizar).
 *     Si no pasa: código 2, antes de cargar Remotion o abrir Chrome.
 *  2. Bundle de Remotion (@remotion/bundler) con public/ enlazado, no copiado (sus symlinks llevan a proyectos/).
 *  3. Video SIN audio: selectComposition + renderMedia (muted, h264 CRF 16, JPEG 95, bt709).
 *  4. Audio aparte: renderMedia con codec wav (48 kHz).
 *  5. loudnorm en 2 pasadas sobre el WAV: la 1ª mide (print_format=json), la 2ª aplica con measured_* y
 *     linear=true. Objetivo: I y TP de la EDL (audio.lufs, audio.pico_dbtp; por defecto −14 LUFS y −1.5 dBTP), LRA 11.
 *  6. Mux: -c:v copy -c:a aac -b:a 256k -ar 48000 -movflags +faststart → salida/final-vN.mp4.
 *  7. Mide el MP4 final con ebur128=peak=true. Si el pico real pasa de −1 dBTP repite 5–7 con TP −2; si
 *     sigue arriba, código 1 con el TP medido (el MP4 no se publica como final).
 * --borrador: un solo render con audio a 720×1280 (scale 0.5), sin loudnorm → salida/borrador-vN.mp4.
 * --forzar: rehace aunque la etapa esté vigente (misma EDL, mismos archivos, mismo código y parámetros).
 *
 * Los tiempos por etapa (bundle, video, audio, loudnorm, mux…) van al manifest (etapa render-vN o
 * borrador-vN) y a reporte.md. Necesita Chrome: corre fuera del sandbox (comando excluido), solo en su llamada.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve, sep} from 'node:path';
import {parseArgs} from 'node:util';
import type {bundle as funcionBundle} from '@remotion/bundler';
import type {openBrowser as funcionOpenBrowser, renderMedia as funcionRenderMedia, selectComposition as funcionSelect} from '@remotion/renderer';
import type {Edicion} from '../src/esquema/edicion.ts';
import {correr, esPrincipal, fallo, FalloEditor} from './lib/fallo.ts';
import {sondear, type Sondeo} from './lib/ffprobe.ts';
import {DIR_PROYECTOS, RAIZ, dirProyecto, etapaVigente, hashearArchivo, registrarEtapa, rutaSalidaSegura, validarSlug, type ArchivoHash} from './lib/manifest.ts';
import {actualizarReporte, crearCheck, fraseConteo, type Check} from './lib/reporte.ts';
import {rutaEnPublic, validarEdicion} from './validar.ts';

export const FPS = 30;
const USO = 'npx tsx herramientas/render.ts <slug> [--version N] [--borrador | --4k] [--forzar]';

export const RENDER = {
	composicion: 'Reel',
	video: {codec: 'h264', crf: 16, x264Preset: 'medium', pixelFormat: 'yuv420p', imageFormat: 'jpeg', jpegQuality: 95, colorSpace: 'bt709'},
	audio: {muestreo: 48000, aac: '256k', wav: 'pcm_s24le'},
	loudnorm: {LRA: 11},
	/** Pico real máximo del MP4 final (dBTP) y el TP con que se reintenta si se pasa. */
	tpMaximo: -1,
	tpReintento: -2,
	/** Tolerancia de la loudness integrada medida contra el objetivo de la EDL (LU). */
	toleranciaI: 1,
	borrador: {escala: 0.5, ancho: 720, alto: 1280, crf: 23},
	/** --4k: el lienzo a ×1.5 (2160×3840) sobre base-4k.mp4 (base.ts --4k), con el mismo loudnorm del final. */
	cuatroK: {escala: 1.5, ancho: 2160, alto: 3840, base: 'base-4k.mp4'},
} as const;

// ───────────────────────── versiones de la EDL ─────────────────────────

export const rutaEdicion = (dir: string, n: number): string => join(dir, `edicion-v${n}.json`);

/** Versiones presentes en la carpeta del proyecto (edicion-vN.json), de menor a mayor. */
export function versionesEdicion(dir: string): number[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((n) => /^edicion-v(\d+)\.json$/.exec(n))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => Number(m[1]))
		.filter((n) => n >= 1)
		.sort((a, b) => a - b);
}

/** La versión pedida (si existe) o la más alta. Código 2 si no hay ninguna o no existe la pedida. */
export function elegirVersion(dir: string, pedida?: number): number {
	const versiones = versionesEdicion(dir);
	if (versiones.length === 0) {
		throw fallo('encontrar la edición', `no hay ningún edicion-vN.json en ${relative(RAIZ, dir) || dir}`, 'escribe primero la EDL del proyecto (edicion-v1.json)', 2);
	}
	if (pedida === undefined) return versiones[versiones.length - 1];
	if (!versiones.includes(pedida)) {
		throw fallo('encontrar la edición', `no existe edicion-v${pedida}.json (hay ${versiones.map((v) => `v${v}`).join(', ')})`, 'revisa el número de --version', 2);
	}
	return pedida;
}

// ───────────────────────── verificación del MP4 (la usa también qa.ts) ─────────────────────────

export type Esperado = {ancho: number; alto: number; cuadros: number};

export type DatosVerificacion = {
	ancho: number;
	alto: number;
	r_frame_rate: string;
	codec_video: string;
	pix_fmt: string | null;
	cuadros: number | null;
	cuadros_esperados: number;
	duracion_video_s: number;
	duracion_audio_s: number | null;
	codec_audio: string | null;
	muestreo_audio: number | null;
	dif_cuadros_audio_video: number | null;
};

/** Los 3 checks que impiden subir: formato, número de cuadros y audio vs video ±1 cuadro. Pura. */
export function verificarVideo(s: Sondeo, esperado: Esperado, fuente: string): {checks: Check[]; datos: DatosVerificacion; problemas: string[]} {
	const v = s.video;
	const duracionVideo = v.duracion ?? s.duracion;
	const duracionAudio = s.audio ? (s.audio.duracion ?? s.duracion) : null;
	const cuadros = v.cuadros;
	const dif = duracionAudio === null ? null : Math.round(Math.abs(duracionAudio - duracionVideo) * FPS * 1000) / 1000;

	const formato: string[] = [];
	if (v.ancho !== esperado.ancho || v.alto !== esperado.alto) formato.push(`mide ${v.ancho}×${v.alto} y no ${esperado.ancho}×${esperado.alto}`);
	if (v.rFrameRate !== `${FPS}/1`) formato.push(`va a ${v.rFrameRate} y no a ${FPS}/1`);
	if (v.codec !== 'h264' || v.pixFmt !== 'yuv420p') formato.push(`video ${v.codec} ${v.pixFmt ?? '?'} y no h264 yuv420p`);
	if (v.rotacion !== 0) formato.push(`trae rotación de ${v.rotacion}°`);
	if (!s.audio) formato.push('no trae audio');
	else if (s.audio.codec !== 'aac' || s.audio.sampleRate !== 48000) formato.push(`audio ${s.audio.codec} a ${s.audio.sampleRate} Hz y no AAC a 48 kHz`);

	const checks: Check[] = [
		crearCheck({
			id: 'qa.formato',
			nombre: 'Formato del MP4',
			nivel: 'bloqueante',
			pasa: formato.length === 0,
			valor: `${v.ancho}×${v.alto} · ${v.rFrameRate} · ${v.codec} ${v.pixFmt ?? '?'} · ${s.audio ? `${s.audio.codec} ${s.audio.sampleRate} Hz` : 'sin audio'}`,
			criterio: `${esperado.ancho}×${esperado.alto}, ${FPS}/1, h264 yuv420p, AAC 48 kHz, sin rotación`,
			n: null,
			fuente,
			...(formato.length ? {nota: formato.join('; ')} : {}),
		}),
		crearCheck({
			id: 'qa.cuadros',
			nombre: 'Cuadros = round(duracion_s × 30)',
			nivel: 'bloqueante',
			pasa: cuadros === null ? null : cuadros === esperado.cuadros,
			valor: cuadros,
			criterio: `= ${esperado.cuadros}`,
			n: null,
			fuente: `${fuente} (nb_frames)`,
			...(cuadros === null ? {nota: 'ffprobe no trae nb_frames'} : {}),
		}),
		crearCheck({
			id: 'qa.audio_video',
			nombre: 'Audio vs video',
			nivel: 'bloqueante',
			pasa: dif === null ? false : dif <= 1 + 1e-6,
			valor: dif === null ? 'sin audio' : `${dif} cuadros (${duracionVideo.toFixed(3)} s vs ${(duracionAudio as number).toFixed(3)} s)`,
			criterio: '±1 cuadro',
			n: null,
			fuente: `${fuente} (duración de cada pista)`,
		}),
	];
	const problemas = checks.filter((c) => c.estado === 'FALLA').map((c) => `${c.nombre}: ${c.nota ?? c.valor}`);
	return {
		checks,
		problemas,
		datos: {
			ancho: v.ancho,
			alto: v.alto,
			r_frame_rate: v.rFrameRate,
			codec_video: v.codec,
			pix_fmt: v.pixFmt,
			cuadros,
			cuadros_esperados: esperado.cuadros,
			duracion_video_s: duracionVideo,
			duracion_audio_s: duracionAudio,
			codec_audio: s.audio?.codec ?? null,
			muestreo_audio: s.audio?.sampleRate ?? null,
			dif_cuadros_audio_video: dif,
		},
	};
}

// ───────────────────────── loudness (puro) ─────────────────────────

export type MedidaLoudnorm = {
	input_i: number;
	input_tp: number;
	input_lra: number;
	input_thresh: number;
	output_i: number;
	output_tp: number;
	output_lra: number;
	output_thresh: number;
	normalization_type: string;
	target_offset: number;
};

const CAMPOS_LOUDNORM = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'output_i', 'output_tp', 'output_lra', 'output_thresh', 'target_offset'] as const;

function numeroLoudnorm(texto: unknown): number {
	if (typeof texto === 'number') return texto;
	const s = String(texto).trim().toLowerCase();
	if (s === '-inf') return Number.NEGATIVE_INFINITY;
	if (s === 'inf' || s === '+inf') return Number.POSITIVE_INFINITY;
	const n = Number(s);
	return Number.isFinite(n) ? n : Number.NaN;
}

/** Lee el JSON que imprime loudnorm (print_format=json) al final del stderr de ffmpeg. */
export function parsearLoudnorm(stderr: string): MedidaLoudnorm {
	const inicio = stderr.lastIndexOf('[Parsed_loudnorm');
	const desde = inicio >= 0 ? stderr.indexOf('{', inicio) : stderr.lastIndexOf('{');
	const hasta = desde >= 0 ? stderr.indexOf('}', desde) : -1;
	if (desde < 0 || hasta < 0) {
		throw fallo('medir la loudness', 'ffmpeg loudnorm no imprimió su JSON', 'revisa proyectos/_logs/fallos.log y avísame', 1, {stderr: stderr.slice(-2000)});
	}
	let crudo: Record<string, unknown>;
	try {
		crudo = JSON.parse(stderr.slice(desde, hasta + 1));
	} catch (error) {
		throw fallo('medir la loudness', 'el JSON de loudnorm no se pudo leer', 'revisa proyectos/_logs/fallos.log y avísame', 1, {error, texto: stderr.slice(desde, hasta + 1)});
	}
	const medida = {normalization_type: String(crudo.normalization_type ?? '')} as MedidaLoudnorm;
	for (const campo of CAMPOS_LOUDNORM) {
		const valor = numeroLoudnorm(crudo[campo]);
		if (Number.isNaN(valor)) {
			throw fallo('medir la loudness', `loudnorm no trae "${campo}" numérico`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {crudo});
		}
		medida[campo] = valor;
	}
	return medida;
}

export type Objetivo = {I: number; TP: number; LRA: number};

/** 1ª pasada: solo mide. */
export function filtroLoudnormMedir(o: Objetivo): string {
	return `loudnorm=I=${o.I}:TP=${o.TP}:LRA=${o.LRA}:print_format=json`;
}

/** 2ª pasada: aplica con lo medido (modo lineal si loudnorm puede; si no, él mismo pasa a dinámico). */
export function filtroLoudnormAplicar(o: Objetivo, m: MedidaLoudnorm): string {
	if (!Number.isFinite(m.input_i) || !Number.isFinite(m.input_tp) || !Number.isFinite(m.input_thresh)) {
		throw fallo('normalizar el audio', `el audio está en silencio (loudnorm midió I = ${m.input_i} LUFS)`, 'revisa que la base de la EDL traiga tu voz', 2);
	}
	return (
		`loudnorm=I=${o.I}:TP=${o.TP}:LRA=${o.LRA}` +
		`:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
		`:offset=${m.target_offset}:linear=true:print_format=json`
	);
}

export type Ebur128 = {I: number; LRA: number; TP: number};

/** Lee el "Summary" de ffmpeg ebur128=peak=true: I (LUFS), LRA (LU) y el pico real (dBTP). */
export function parsearEbur128(stderr: string): Ebur128 {
	const i = stderr.lastIndexOf('Summary:');
	const resumen = i >= 0 ? stderr.slice(i) : '';
	const num = (re: RegExp): number | null => {
		const m = re.exec(resumen);
		return m ? numeroLoudnorm(m[1]) : null;
	};
	const I = num(/I:\s+(-?[\d.]+|-?inf)\s+LUFS/);
	const LRA = num(/LRA:\s+(-?[\d.]+|-?inf)\s+LU\b/);
	const TP = num(/True peak:\s*\n\s*Peak:\s+(-?[\d.]+|-?inf)\s+dBFS/);
	if (I === null || LRA === null || TP === null) {
		throw fallo('medir la loudness del MP4', 'ffmpeg ebur128 no imprimió su resumen (I, LRA y pico real)', 'revisa proyectos/_logs/fallos.log y avísame', 1, {stderr: stderr.slice(-2000)});
	}
	return {I, LRA, TP};
}

/**
 * Por qué la loudness integrada no llegó (null si llegó). Solo con lo medido: loudnorm aplica ganancia lineal
 * si el pico medido + la ganancia no pasa del TP objetivo; si pasa, cambia a su modo dinámico, que puede
 * quedarse corto (p. ej. en un audio casi sin voz con un SFX fuerte, como el clip de prueba de 3 s).
 */
export function notaLoudness(final: Ebur128, intento: Pick<Intento, 'tp_objetivo' | 'primera_pasada' | 'segunda_pasada'>, objetivoI: number): string | null {
	if (Math.abs(final.I - objetivoI) <= RENDER.toleranciaI) return null;
	const p = intento.primera_pasada;
	const ganancia = objetivoI - p.input_i;
	const picoLineal = p.input_tp + ganancia;
	const r1 = (x: number) => Math.round(x * 10) / 10;
	if (intento.segunda_pasada.normalization_type === 'dynamic' && picoLineal > intento.tp_objetivo) {
		return `loudnorm no pudo subir ${r1(ganancia)} dB en lineal (el pico habría quedado en ${r1(picoLineal)} dBTP, arriba de ${intento.tp_objetivo}) y en modo dinámico se quedó en ${final.I} LUFS`;
	}
	return `loudnorm (modo ${intento.segunda_pasada.normalization_type}) dejó ${final.I} LUFS con objetivo ${objetivoI}`;
}

/** TP del reintento: −2 dBTP (o 0.5 dB por debajo del objetivo, si la EDL ya pide menos de −1.5). */
export const tpDeReintento = (tpObjetivo: number): number => Math.min(tpObjetivo - 0.5, RENDER.tpReintento);

// ───────────────────────── ffmpeg ─────────────────────────

function ffmpeg(args: string[], que: string): string {
	const r = spawnSync('ffmpeg', args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
	if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
		throw fallo(que, 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú) y vuelve a intentar', 2);
	}
	if (r.status !== 0) {
		const ultima = (r.stderr ?? '').trim().split('\n').pop()?.trim() || `código ${r.status ?? r.signal}`;
		throw fallo(que, `ffmpeg terminó con error (${ultima})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: r.stderr?.slice(-4000)});
	}
	return r.stderr ?? '';
}

export function medirLoudnorm(wav: string, o: Objetivo): MedidaLoudnorm {
	return parsearLoudnorm(ffmpeg(['-nostdin', '-hide_banner', '-nostats', '-i', wav, '-af', filtroLoudnormMedir(o), '-f', 'null', '-'], 'medir la loudness (1ª pasada)'));
}

/** 2ª pasada → WAV a 48 kHz con exactamente `muestras` muestras (lo que dura el video). */
export function aplicarLoudnorm(wav: string, salida: string, o: Objetivo, m: MedidaLoudnorm, muestras: number): MedidaLoudnorm {
	const filtro = `${filtroLoudnormAplicar(o, m)},aresample=${RENDER.audio.muestreo},apad=whole_len=${muestras},atrim=end_sample=${muestras}`;
	const stderr = ffmpeg(['-nostdin', '-hide_banner', '-nostats', '-y', '-i', wav, '-af', filtro, '-ar', String(RENDER.audio.muestreo), '-c:a', RENDER.audio.wav, salida], 'normalizar el audio (2ª pasada)');
	return parsearLoudnorm(stderr);
}

export function mux(video: string, audio: string, salida: string): void {
	ffmpeg(
		['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', RENDER.audio.aac, '-ar', String(RENDER.audio.muestreo), '-map_metadata', '-1', '-movflags', '+faststart', salida],
		'unir video y audio',
	);
}

export function medirEbur128(mp4: string): Ebur128 {
	return parsearEbur128(ffmpeg(['-nostdin', '-hide_banner', '-nostats', '-i', mp4, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], 'medir la loudness del MP4 final'));
}

// ───────────────────────── entradas y parámetros ─────────────────────────

/** Rutas (relativas a public/) de todo lo que la EDL usa. */
export function archivosDeLaEdicion(e: Edicion): string[] {
	const rutas = [e.base];
	for (const s of e.stickers) {
		rutas.push(s.asset);
		if (s.sfx) rutas.push(s.sfx.asset);
	}
	for (const x of e.inserts) {
		// Un insert motion ("motion:<nombre>") lo dibuja código de src/ (lo cubre hashCodigo), no un archivo.
		if (!x.asset.startsWith('motion:')) rutas.push(x.asset);
		if (x.sfx) rutas.push(x.sfx.asset);
	}
	for (const x of e.sfx_extra) rutas.push(x.sfx.asset);
	return [...new Set(rutas)];
}

/** sha256 del código que dibuja el reel (src/): si cambia, el render deja de estar vigente. */
export function hashCodigo(dirSrc = join(RAIZ, 'src')): string {
	const archivos: string[] = [];
	const recorrer = (d: string) => {
		for (const n of readdirSync(d).sort()) {
			const ruta = join(d, n);
			if (statSync(ruta).isDirectory()) recorrer(ruta);
			else if (!n.startsWith('.')) archivos.push(ruta);
		}
	};
	recorrer(dirSrc);
	const hash = createHash('sha256');
	for (const ruta of archivos) hash.update(`${relative(dirSrc, ruta)}\u0000`).update(readFileSync(ruta)).update('\u0000');
	return hash.digest('hex');
}

function versionRemotion(): string {
	try {
		return JSON.parse(readFileSync(join(RAIZ, 'node_modules', 'remotion', 'package.json'), 'utf8')).version ?? 'desconocida';
	} catch {
		return 'desconocida';
	}
}

// ───────────────────────── motor (Remotion) ─────────────────────────

/** Las 4 funciones de Remotion que se usan. Se inyectan en las pruebas; en uso real se cargan al vuelo. */
export type Motor = {
	bundle: typeof funcionBundle;
	openBrowser: typeof funcionOpenBrowser;
	selectComposition: typeof funcionSelect;
	renderMedia: typeof funcionRenderMedia;
};

async function cargarMotor(): Promise<Motor> {
	const {bundle} = await import('@remotion/bundler');
	const {openBrowser, selectComposition, renderMedia} = await import('@remotion/renderer');
	return {bundle, openBrowser, selectComposition, renderMedia};
}

/** Error de Remotion → una frase; si huele a sandbox (Chrome no arranca), lo dice. */
function falloRemotion(que: string, error: unknown, slug: string): FalloEditor {
	if (error instanceof FalloEditor) return error;
	const texto = error instanceof Error ? `${error.message}` : String(error);
	const primera = texto.split('\n')[0].slice(0, 200);
	const sandbox = /bootstrap_check_in|Failed to launch|Mach|sandbox|Operation not permitted|EPERM/i.test(texto);
	return fallo(
		que,
		`Remotion falló (${primera})`,
		sandbox
			? `corre \`npx tsx herramientas/render.ts ${slug}\` solo en su llamada de Bash: es un comando excluido del sandbox porque Chrome no arranca dentro`
			: 'revisa proyectos/_logs/fallos.log y avísame',
		1,
		error,
	);
}

/** Borra la carpeta temporal del bundle sin tocar jamás lo que enlaza su public/ (tus proyectos). */
function borrarBundle(dir: string): void {
	const real = resolve(dir);
	if (!real.startsWith(resolve(tmpdir()) + sep) || !real.includes('remotion-webpack-bundle-')) return;
	const publico = join(real, 'public');
	try {
		if (lstatSync(publico).isSymbolicLink()) unlinkSync(publico);
	} catch {
		// sin public/: nada que desenlazar
	}
	rmSync(real, {recursive: true, force: true});
}

// ───────────────────────── render ─────────────────────────

export type OpcionesRender = {
	slug: string;
	version?: number;
	borrador?: boolean;
	/** Final en 4K (2160×3840): necesita proyectos/<slug>/base-4k.mp4 (npx tsx herramientas/base.ts <slug> --4k). */
	cuatroK?: boolean;
	forzar?: boolean;
	proyectos?: string;
	motor?: Motor;
	avisar?: (m: string) => void;
};

export type Intento = {tp_objetivo: number; primera_pasada: MedidaLoudnorm; segunda_pasada: MedidaLoudnorm; final: Ebur128};

export type ResultadoRender = {
	slug: string;
	version: number;
	borrador: boolean;
	salida: string;
	reutilizado: boolean;
	tiempos_s: Record<string, number>;
	total_s: number;
	intentos: Intento[];
	loudness: Ebur128 | null;
	checks: Check[];
	resumen: string;
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Valida la EDL (código 2 si no pasa) y la devuelve. No carga Remotion. */
export function validarParaRender(rutaEdl: string): Edicion {
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(rutaEdl, 'utf8'));
	} catch (error) {
		throw fallo('leer la edición', `${relative(RAIZ, rutaEdl)} no es JSON válido`, 'corrige el JSON y vuelve a renderizar', 2, error);
	}
	const {edicion, hallazgos} = validarEdicion(datos);
	if (hallazgos.length > 0 || !edicion) {
		console.log(`✖ ${relative(RAIZ, rutaEdl)}: ${hallazgos.length} problema(s)`);
		for (const h of hallazgos) console.log(`  - [${h.regla}] ${h.donde}: ${h.detalle}`);
		throw fallo('renderizar', `la edición no pasa validar.ts (${hallazgos.length} problema(s))`, 'corrige los puntos de arriba y vuelve a renderizar', 2, hallazgos);
	}
	return edicion;
}

export async function renderizar(op: OpcionesRender): Promise<ResultadoRender> {
	const t0 = performance.now();
	const avisar = op.avisar ?? ((m: string) => console.error(m));
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const slug = validarSlug(op.slug);
	const dir = dirProyecto(slug, proyectos);
	if (!existsSync(dir)) throw fallo(`renderizar ${slug}`, `no existe proyectos/${slug}`, 'revisa el slug (la carpeta de proyectos/)', 2);
	const version = elegirVersion(dir, op.version);
	const borrador = Boolean(op.borrador);
	const rutaEdl = rutaEdicion(dir, version);
	const tiempos: Record<string, number> = {};
	const cronometrar = async <T>(etapa: string, fn: () => Promise<T> | T): Promise<T> => {
		const t = performance.now();
		try {
			return await fn();
		} finally {
			tiempos[etapa] = r2((tiempos[etapa] ?? 0) + (performance.now() - t) / 1000);
		}
	};

	// 1. Validación: antes de tocar Remotion, Chrome o la carpeta de salida.
	const cuatroK = Boolean(op.cuatroK);
	if (cuatroK && borrador) throw fallo('leer los argumentos', '--4k y --borrador no van juntos', `usa ${USO}`, 2);
	const validada = await cronometrar('validacion', () => validarParaRender(rutaEdl));
	// En 4K solo cambia el video de fondo: la misma EDL (posiciones en base 1080×1920) se dibuja a ×1.5.
	const edicion: Edicion = cuatroK ? {...validada, base: validada.base.replace(/base\.mp4$/, RENDER.cuatroK.base)} : validada;
	if (cuatroK && (edicion.base === validada.base || !existsSync(rutaEnPublic(edicion.base)))) {
		throw fallo(`renderizar ${slug} en 4K`, `falta proyectos/${slug}/${RENDER.cuatroK.base}`, `corre primero npx tsx herramientas/base.ts ${slug} --cortes proyectos/${slug}/cortes.json --4k`, 2);
	}
	const cuadros = Math.max(1, Math.round(edicion.duracion_s * FPS));
	const objetivo: Objetivo = {I: edicion.audio.lufs, TP: edicion.audio.pico_dbtp, LRA: RENDER.loudnorm.LRA};

	const etapa = `${borrador ? 'borrador' : 'render'}-v${version}${cuatroK ? '-4k' : ''}`;
	const nombreSalida = `${borrador ? 'borrador' : 'final'}-v${version}${cuatroK ? '-4k' : ''}.mp4`;
	const destino = rutaSalidaSegura(slug, join('salida', nombreSalida), rutaEnPublic(edicion.base), proyectos);
	const entradas: ArchivoHash[] = await cronometrar('preparacion', async () => [
		await hashearArchivo(rutaEdl),
		...(await Promise.all(archivosDeLaEdicion(edicion).map((r) => hashearArchivo(rutaEnPublic(r))))),
	]);
	const parametros: Record<string, unknown> = {
		version: 1,
		tipo: borrador ? 'borrador' : 'final',
		composicion: RENDER.composicion,
		remotion: versionRemotion(),
		codigo_sha256: hashCodigo(),
		video: borrador ? {...RENDER.video, crf: RENDER.borrador.crf, escala: RENDER.borrador.escala} : cuatroK ? {...RENDER.video, escala: RENDER.cuatroK.escala} : RENDER.video,
		audio: borrador ? {aac: 'por defecto de Remotion', loudnorm: null} : {...RENDER.audio, loudnorm: objetivo, tp_maximo: RENDER.tpMaximo, tp_reintento: tpDeReintento(objetivo.TP)},
	};
	if (!op.forzar && (await etapaVigente(slug, etapa, entradas, parametros, proyectos))) {
		const total = (performance.now() - t0) / 1000;
		return {slug, version, borrador, salida: destino, reutilizado: true, tiempos_s: tiempos, total_s: r2(total), intentos: [], loudness: null, checks: [], resumen: `${relative(RAIZ, destino)} ya estaba al día (misma EDL, archivos, código y parámetros); usa --forzar para rehacerlo.`};
	}

	registrarEtapa(slug, etapa, {estado: 'en-curso', entradas, parametros}, proyectos);
	const trabajo = rutaSalidaSegura(slug, join('salida', `.trabajo-${etapa}`), rutaEnPublic(edicion.base), proyectos);
	rmSync(trabajo, {recursive: true, force: true});
	mkdirSync(trabajo, {recursive: true});
	const rutaVideo = join(trabajo, borrador ? 'borrador.mp4' : 'video-mudo.mp4');
	const rutaWav = join(trabajo, 'audio.wav');
	const rutaWavNorm = join(trabajo, 'audio-norm.wav');
	const rutaFinal = join(trabajo, 'final.mp4');

	let serveUrl: string | null = null;
	let fallidaRegistrada = false;
	const intentos: Intento[] = [];
	try {
		const motor = op.motor ?? (await cargarMotor().catch((error: unknown) => {
			throw falloRemotion('cargar Remotion', error, slug);
		}));
		// 2. Bundle
		avisar(`Render ${borrador ? 'borrador' : cuatroK ? 'final 4K (2160×3840)' : 'final'} de ${slug} v${version} (${cuadros} cuadros)…`);
		serveUrl = await cronometrar('bundle', async () => {
			try {
				return await motor.bundle({entryPoint: join(RAIZ, 'src', 'index.ts'), rootDir: RAIZ, publicDir: join(RAIZ, 'public'), symlinkPublicDir: true, enableCaching: true, onProgress: () => {}});
			} catch (error) {
				throw falloRemotion(`armar el bundle de ${slug}`, error, slug);
			}
		});

		// 3–4. Video (y audio) con un solo Chrome
		const navegador = await cronometrar('navegador', async () => {
			try {
				return await motor.openBrowser('chrome', {logLevel: 'error'});
			} catch (error) {
				throw falloRemotion('abrir Chrome para el render', error, slug);
			}
		});
		try {
			const comun = {serveUrl: serveUrl as string, inputProps: edicion as unknown as Record<string, unknown>, puppeteerInstance: navegador, logLevel: 'error' as const};
			const composicion = await cronometrar('composicion', async () => {
				try {
					return await motor.selectComposition({...comun, id: RENDER.composicion});
				} catch (error) {
					throw falloRemotion(`leer la composición ${RENDER.composicion}`, error, slug);
				}
			});
			if (composicion.durationInFrames !== cuadros || composicion.fps !== FPS) {
				throw fallo('preparar el render', `la composición da ${composicion.durationInFrames} cuadros a ${composicion.fps} fps y la EDL pide ${cuadros} a ${FPS}`, 'revisa calculateMetadata en src/Root.tsx', 1);
			}
			const progreso = (que: string) => {
				let ultimo = -1;
				return ({progress}: {progress: number}) => {
					const paso = Math.floor(progress * 10);
					if (paso > ultimo) {
						ultimo = paso;
						avisar(`  ${que}: ${paso * 10} %`);
					}
				};
			};
			const v = RENDER.video;
			await cronometrar('video', async () => {
				try {
					await motor.renderMedia({
						...comun,
						composition: composicion,
						codec: 'h264',
						outputLocation: rutaVideo,
						overwrite: true,
						muted: !borrador,
						crf: borrador ? RENDER.borrador.crf : v.crf,
						x264Preset: v.x264Preset,
						pixelFormat: v.pixelFormat,
						imageFormat: v.imageFormat,
						jpegQuality: v.jpegQuality,
						colorSpace: v.colorSpace,
						scale: borrador ? RENDER.borrador.escala : cuatroK ? RENDER.cuatroK.escala : 1,
						...(borrador ? {audioCodec: 'aac' as const, enforceAudioTrack: true} : {}),
						onProgress: progreso(borrador ? 'borrador' : 'video'),
					});
				} catch (error) {
					throw falloRemotion(`renderizar el video de ${slug} v${version}`, error, slug);
				}
			});
			if (!borrador) {
				await cronometrar('audio', async () => {
					try {
						await motor.renderMedia({...comun, composition: composicion, codec: 'wav', outputLocation: rutaWav, overwrite: true, enforceAudioTrack: true, sampleRate: RENDER.audio.muestreo, onProgress: progreso('audio')});
					} catch (error) {
						throw falloRemotion(`renderizar el audio de ${slug} v${version}`, error, slug);
					}
				});
			}
		} finally {
			await navegador.close({silent: true}).catch(() => {});
		}

		// Borrador: sin loudnorm. Se verifica y se publica.
		if (borrador) {
			const verif = await cronometrar('verificacion', async () => verificarVideo(await sondear(rutaVideo), {ancho: RENDER.borrador.ancho, alto: RENDER.borrador.alto, cuadros}, `ffprobe de salida/${nombreSalida}`));
			if (verif.problemas.length > 0) throw fallo(`verificar el borrador de ${slug} v${version}`, verif.problemas.join('; '), `revisa ${relative(RAIZ, rutaVideo)} y avísame`, 1, verif.datos);
			mkdirSync(join(dir, 'salida'), {recursive: true});
			renameSync(rutaVideo, destino);
		} else {
			// 5–7. loudnorm en 2 pasadas, mux y medición; un reintento con TP más bajo si el pico se pasa.
			const muestras = cuadros * (RENDER.audio.muestreo / FPS);
			for (const tp of [objetivo.TP, tpDeReintento(objetivo.TP)]) {
				const o = {...objetivo, TP: tp};
				const [primera, segunda] = await cronometrar('loudnorm', () => {
					const m = medirLoudnorm(rutaWav, o);
					return [m, aplicarLoudnorm(rutaWav, rutaWavNorm, o, m, muestras)] as const;
				});
				await cronometrar('mux', () => mux(rutaVideo, rutaWavNorm, rutaFinal));
				const final = await cronometrar('medicion', () => medirEbur128(rutaFinal));
				intentos.push({tp_objetivo: tp, primera_pasada: primera, segunda_pasada: segunda, final});
				avisar(`  loudness con TP ${tp}: I ${final.I} LUFS, pico real ${final.TP} dBTP (loudnorm ${segunda.normalization_type})`);
				if (final.TP <= RENDER.tpMaximo) break;
			}
			const ultimo = intentos[intentos.length - 1].final;
			if (ultimo.TP > RENDER.tpMaximo) {
				registrarEtapa(slug, etapa, {estado: 'fallida', entradas, parametros, extra: {tiempos_s: tiempos, intentos}}, proyectos);
				fallidaRegistrada = true;
				throw fallo(`dejar el pico real del final de ${slug} v${version} en ${RENDER.tpMaximo} dBTP o menos`, `con TP ${intentos.map((x) => x.tp_objetivo).join(' y ')} el MP4 midió ${intentos.map((x) => x.final.TP).join(' y ')} dBTP`, `revisa ${relative(RAIZ, rutaFinal)} y avísame`, 1, intentos);
			}
			const verif = await cronometrar('verificacion', async () => verificarVideo(await sondear(rutaFinal), cuatroK ? {ancho: RENDER.cuatroK.ancho, alto: RENDER.cuatroK.alto, cuadros} : {ancho: 1440, alto: 2560, cuadros}, `ffprobe de salida/${nombreSalida}`));
			if (verif.problemas.length > 0) throw fallo(`verificar el final de ${slug} v${version}`, verif.problemas.join('; '), `revisa ${relative(RAIZ, rutaFinal)} y avísame`, 1, verif.datos);
			mkdirSync(join(dir, 'salida'), {recursive: true});
			renameSync(rutaFinal, destino);
		}
	} catch (error) {
		if (!fallidaRegistrada) registrarEtapa(slug, etapa, {estado: 'fallida', entradas, parametros, extra: {tiempos_s: tiempos, intentos}}, proyectos);
		throw error;
	} finally {
		if (serveUrl) borrarBundle(serveUrl);
	}
	rmSync(trabajo, {recursive: true, force: true});

	// Registro: manifest + reporte
	const total = r2((performance.now() - t0) / 1000);
	const salida = await hashearArchivo(destino, dir);
	const loudness = intentos.length ? intentos[intentos.length - 1].final : null;
	const checks: Check[] = [];
	const detalle: string[] = [`Salida: salida/${nombreSalida} (${((salida.bytes ?? 0) / 1e6).toFixed(1)} MB, ${cuadros} cuadros, ${edicion.duracion_s} s).`];
	if (loudness) {
		const ultimo = intentos[intentos.length - 1];
		const nota = notaLoudness(loudness, ultimo, objetivo.I);
		checks.push(
			crearCheck({
				id: 'render.loudness',
				nombre: 'Loudness integrada del MP4 final',
				nivel: 'bloqueante',
				pasa: Math.abs(loudness.I - objetivo.I) <= RENDER.toleranciaI,
				valor: `${loudness.I} LUFS`,
				criterio: `${objetivo.I} ±${RENDER.toleranciaI} LUFS`,
				n: null,
				fuente: `ffmpeg ebur128=peak=true sobre salida/${nombreSalida}`,
				...(nota ? {nota} : {}),
			}),
			crearCheck({
				id: 'render.pico',
				nombre: 'Pico real (true peak) del MP4 final',
				nivel: 'bloqueante',
				pasa: loudness.TP <= RENDER.tpMaximo,
				valor: `${loudness.TP} dBTP`,
				criterio: `≤ ${RENDER.tpMaximo} dBTP`,
				n: null,
				fuente: `ffmpeg ebur128=peak=true sobre salida/${nombreSalida}`,
				...(intentos.length > 1 ? {nota: `con TP ${intentos[0].tp_objetivo} midió ${intentos[0].final.TP} dBTP; se repitió con TP ${ultimo.tp_objetivo}`} : {}),
			}),
		);
		detalle.push(
			`Loudness: 1ª pasada midió I ${ultimo.primera_pasada.input_i} LUFS, pico ${ultimo.primera_pasada.input_tp} dBTP, LRA ${ultimo.primera_pasada.input_lra} LU; loudnorm aplicó en modo ${ultimo.segunda_pasada.normalization_type} (objetivo I ${objetivo.I}, TP ${ultimo.tp_objetivo}, LRA ${objetivo.LRA}). MP4 final: I ${loudness.I} LUFS, LRA ${loudness.LRA} LU, pico real ${loudness.TP} dBTP${intentos.length > 1 ? ` (${intentos.length} intentos)` : ''}.`,
		);
	}
	registrarEtapa(slug, etapa, {estado: 'terminada', entradas, parametros, salidas: [salida], extra: {tiempos_s: tiempos, duracion_proceso_s: total, intentos, cuadros}}, proyectos);
	const {conteo} = actualizarReporte(slug, version, borrador ? 'borrador' : cuatroK ? 'render-4k' : 'render', {titulo: borrador ? 'Borrador 720×1280' : cuatroK ? 'Render final 4K 2160×3840' : 'Render final', checks, tiempos_s: tiempos, detalle}, proyectos);
	const resumen =
		`Listo: ${relative(RAIZ, destino)} en ${total.toFixed(1)} s (${Object.entries(tiempos).map(([k, s]) => `${k} ${s.toFixed(1)} s`).join(' · ')})` +
		(loudness ? `. Loudness ${loudness.I} LUFS, pico real ${loudness.TP} dBTP. Reporte: ${fraseConteo(conteo)}.` : '.');
	return {slug, version, borrador, salida: destino, reutilizado: false, tiempos_s: tiempos, total_s: total, intentos, loudness, checks, resumen};
}

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		options: {version: {type: 'string'}, borrador: {type: 'boolean', default: false}, '4k': {type: 'boolean', default: false}, forzar: {type: 'boolean', default: false}},
	});
	const slug = positionals[0];
	if (!slug) throw fallo('renderizar', 'falta el slug del proyecto', `usa ${USO}`, 2);
	const version = values.version === undefined ? undefined : Number(values.version);
	if (version !== undefined && !(Number.isInteger(version) && version >= 1)) {
		throw fallo('renderizar', `--version tiene que ser un entero ≥ 1 (me llegó "${values.version}")`, `usa ${USO}`, 2);
	}
	const r = await renderizar({slug, version, borrador: values.borrador, cuatroK: values['4k'], forzar: values.forzar});
	console.log(r.resumen);
}

if (esPrincipal(import.meta.url)) void correr(main);

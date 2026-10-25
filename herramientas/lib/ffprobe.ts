// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Sondeo de videos con ffprobe: duración, códec, tamaño, rotación, fps (real y nominal), color y audio.
 *
 * - `sondear(ruta)` corre ffprobe y devuelve el resumen tipado.
 * - `interpretarSondeo(crudo, ruta)` es pura: recibe el JSON de ffprobe, así se prueba con objetos simulados.
 * - `revisarApto(sondeo)` aplica la regla de la casa: HDR o sin audio → código 2 (te pregunto).
 * - `correrFfmpeg(args)` corre ffmpeg sin shell y traduce sus fallos al formato de fallo.ts.
 *
 * Convenciones:
 * - `rotacion` sale de la matriz de visualización (side_data "Display Matrix"), en grados y con la
 *   convención de ffprobe (antihoraria), normalizada a (−180, 180]. Ej.: IMG_3905 → +90, IMG_4323 → −90.
 * - `ancho`/`alto` son los del archivo tal cual; `anchoVisible`/`altoVisible`, los que se ven ya rotados.
 * - `fpsReal` = avg_frame_rate; `fpsNominal` = r_frame_rate; `vfr` = difieren más de 0.5 %.
 * - `hdr` = la transferencia es HLG (arib-std-b67) o PQ (smpte2084).
 */
import {execFile, spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename} from 'node:path';
import {promisify} from 'node:util';
import {fallo} from './fallo.ts';

const execFileP = promisify(execFile);

/** Transferencias que tratamos como HDR: HLG (lo que graba el iPhone en HDR) y PQ (HDR10 / Dolby Vision). */
export const TRANSFERENCIAS_HDR = ['arib-std-b67', 'smpte2084'] as const;

/** Tolerancia para llamar VFR a un clip: avg_frame_rate y r_frame_rate difieren más de 0.5 %. */
export const UMBRAL_VFR = 0.005;

export type SondeoVideo = {
	/** Índice absoluto del stream en el archivo (para `-map 0:<indice>`). */
	indice: number;
	codec: string;
	ancho: number;
	alto: number;
	rotacion: number;
	anchoVisible: number;
	altoVisible: number;
	fpsReal: number;
	fpsNominal: number;
	/** Texto crudo de ffprobe, p. ej. "30/1". */
	rFrameRate: string;
	avgFrameRate: string;
	vfr: boolean;
	colorTransfer: string | null;
	colorPrimaries: string | null;
	colorSpace: string | null;
	pixFmt: string | null;
	hdr: boolean;
	/** Duración del stream de video (s), si el contenedor la trae. */
	duracion: number | null;
	/** nb_frames, si el contenedor lo trae. */
	cuadros: number | null;
};

export type SondeoAudio = {
	indice: number;
	codec: string;
	sampleRate: number;
	canales: number;
	duracion: number | null;
};

export type Sondeo = {
	ruta: string;
	/** Duración del contenedor (s). */
	duracion: number;
	video: SondeoVideo;
	audio: SondeoAudio | null;
	/** creation_time del contenedor (UTC, ISO), o null. */
	creationTime: string | null;
	/** com.apple.quicktime.creationdate (hora local con su zona), o null si no es de iPhone. */
	creationTimeLocal: string | null;
};

type LadoDatos = {side_data_type?: string; rotation?: number; displaymatrix?: string};

export type StreamCrudo = {
	index?: number;
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	r_frame_rate?: string;
	avg_frame_rate?: string;
	color_transfer?: string;
	color_primaries?: string;
	color_space?: string;
	pix_fmt?: string;
	duration?: string;
	nb_frames?: string;
	sample_rate?: string;
	channels?: number;
	disposition?: {attached_pic?: number};
	tags?: Record<string, string>;
	side_data_list?: LadoDatos[];
};

export type FfprobeCrudo = {
	streams?: StreamCrudo[];
	format?: {duration?: string; tags?: Record<string, string>};
};

/** "1185360/19757" → 59.9969…; "30" → 30; "0/0" o basura → 0. */
export function fraccion(texto: string | undefined): number {
	if (!texto) return 0;
	const [n, d] = texto.split('/').map(Number);
	if (!Number.isFinite(n)) return 0;
	if (d === undefined) return n;
	if (!Number.isFinite(d) || d === 0) return 0;
	return n / d;
}

/** ¿La transferencia de color es HDR? */
export function esHdr(colorTransfer: string | null | undefined): boolean {
	return colorTransfer != null && (TRANSFERENCIAS_HDR as readonly string[]).includes(colorTransfer);
}

/** ¿avg_frame_rate y r_frame_rate difieren más del umbral? */
export function esVfr(fpsReal: number, fpsNominal: number): boolean {
	if (!(fpsReal > 0) || !(fpsNominal > 0)) return false;
	return Math.abs(fpsReal - fpsNominal) / fpsNominal > UMBRAL_VFR;
}

/** Lleva cualquier ángulo a (−180, 180], entero. */
export function normalizarGrados(grados: number): number {
	let r = Math.round(grados) % 360;
	if (r > 180) r -= 360;
	if (r <= -180) r += 360;
	return r === 0 ? 0 : r; // evita −0
}

/**
 * Ángulo de la matriz de visualización tal como la imprime ffprobe (3 renglones "0000000N: a b c").
 * Replica av_display_rotation_get(): −atan2(m[1]/|col1|, m[0]/|col0|).
 */
export function rotacionDeMatriz(texto: string): number | null {
	const numeros = texto
		.split('\n')
		.map((linea) => linea.replace(/^\s*[0-9a-f]+:/i, '').trim())
		.filter((linea) => linea.length > 0)
		.flatMap((linea) => linea.split(/\s+/).map(Number));
	if (numeros.length !== 9 || numeros.some((n) => !Number.isFinite(n))) return null;
	const [m0, m1, , m3, m4] = numeros;
	const escala0 = Math.hypot(m0, m3);
	const escala1 = Math.hypot(m1, m4);
	if (escala0 === 0 || escala1 === 0) return null;
	return -(Math.atan2(m1 / escala1, m0 / escala0) * 180) / Math.PI;
}

/** Rotación del stream: primero `rotation` de la matriz, luego la matriz en texto y al final el tag viejo `rotate`. */
export function rotacionDeStream(stream: StreamCrudo): number {
	const matriz = stream.side_data_list?.find((sd) => sd.side_data_type === 'Display Matrix');
	let grados: number | null = null;
	if (matriz) {
		if (typeof matriz.rotation === 'number' && Number.isFinite(matriz.rotation)) grados = matriz.rotation;
		else if (typeof matriz.displaymatrix === 'string') grados = rotacionDeMatriz(matriz.displaymatrix);
	}
	if (grados === null && stream.tags?.rotate !== undefined) {
		// ffmpeg viejo escribía "rotate" en sentido horario; ffprobe moderno reporta antihorario.
		const viejo = Number(stream.tags.rotate);
		if (Number.isFinite(viejo)) grados = -viejo;
	}
	return normalizarGrados(grados ?? 0);
}

const numeroONull = (texto: string | undefined): number | null => {
	if (texto === undefined || texto === 'N/A') return null;
	const n = Number(texto);
	return Number.isFinite(n) ? n : null;
};

/** Convierte el JSON de ffprobe en el resumen que usa el editor. Pura: no toca disco. */
export function interpretarSondeo(crudo: FfprobeCrudo, ruta: string): Sondeo {
	const nombre = basename(ruta);
	const streams = crudo.streams ?? [];
	const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
	if (!v) {
		throw fallo(`leer ${nombre}`, 'no trae pista de video', 'usa el archivo original de la cámara (.MOV o .mp4)', 2);
	}
	const ancho = v.width ?? 0;
	const alto = v.height ?? 0;
	if (!(ancho > 0) || !(alto > 0)) {
		throw fallo(`leer ${nombre}`, 'ffprobe no reporta el tamaño del video', 'revisa que el archivo esté completo y vuelve a intentar', 2);
	}

	const rotacion = rotacionDeStream(v);
	const girado = Math.abs(rotacion) === 90;
	const fpsNominal = fraccion(v.r_frame_rate);
	const fpsPromedio = fraccion(v.avg_frame_rate);
	const fpsReal = fpsPromedio > 0 ? fpsPromedio : fpsNominal;
	const colorTransfer = v.color_transfer ?? null;

	const duracion = numeroONull(crudo.format?.duration) ?? numeroONull(v.duration);
	if (duracion === null || !(duracion > 0)) {
		throw fallo(`leer ${nombre}`, 'ffprobe no reporta su duración', 'revisa que el archivo esté completo y no a medio copiar', 2);
	}

	const a = streams.find((s) => s.codec_type === 'audio');
	const audio: SondeoAudio | null = a
		? {
				indice: a.index ?? streams.indexOf(a),
				codec: a.codec_name ?? 'desconocido',
				sampleRate: Number(a.sample_rate ?? 0),
				canales: a.channels ?? 0,
				duracion: numeroONull(a.duration),
			}
		: null;

	const tagsFormato = crudo.format?.tags ?? {};
	return {
		ruta,
		duracion,
		video: {
			indice: v.index ?? streams.indexOf(v),
			codec: v.codec_name ?? 'desconocido',
			ancho,
			alto,
			rotacion,
			anchoVisible: girado ? alto : ancho,
			altoVisible: girado ? ancho : alto,
			fpsReal,
			fpsNominal,
			rFrameRate: v.r_frame_rate ?? '0/0',
			avgFrameRate: v.avg_frame_rate ?? '0/0',
			vfr: esVfr(fpsReal, fpsNominal),
			colorTransfer,
			colorPrimaries: v.color_primaries ?? null,
			colorSpace: v.color_space ?? null,
			pixFmt: v.pix_fmt ?? null,
			hdr: esHdr(colorTransfer),
			duracion: numeroONull(v.duration),
			cuadros: numeroONull(v.nb_frames),
		},
		audio,
		creationTime: tagsFormato.creation_time ?? v.tags?.creation_time ?? null,
		creationTimeLocal: tagsFormato['com.apple.quicktime.creationdate'] ?? null,
	};
}

/** Corre ffprobe y devuelve su JSON crudo (streams + format). Sirve también para WAV y otros sin video. */
export async function ffprobeJson(ruta: string): Promise<FfprobeCrudo> {
	const nombre = basename(ruta);
	if (!existsSync(ruta)) {
		throw fallo(`leer ${nombre}`, `no existe ${ruta}`, 'revisa la ruta (arrástrala a la terminal para copiarla exacta)', 2);
	}
	let stdout: string;
	try {
		({stdout} = await execFileP(
			'ffprobe',
			['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ruta],
			{maxBuffer: 32 * 1024 * 1024},
		));
	} catch (error) {
		const e = error as NodeJS.ErrnoException & {stderr?: string};
		if (e.code === 'ENOENT') {
			throw fallo('sondear el video', 'no encuentro ffprobe en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú) y vuelve a intentar', 2, e);
		}
		const motivo = (e.stderr ?? '').trim().split('\n').pop() || 'formato no reconocido';
		throw fallo(`leer ${nombre}`, `ffprobe no lo pudo abrir (${motivo})`, 'revisa que sea un video completo y no un archivo a medio copiar', 2, e);
	}
	try {
		return JSON.parse(stdout) as FfprobeCrudo;
	} catch (error) {
		throw fallo('sondear el video', 'ffprobe devolvió algo que no es JSON', 'revisa proyectos/_logs/fallos.log y avísame', 1, {error, salida: stdout.slice(0, 2000)});
	}
}

/** Sondea un video: rotación, fps real y nominal, VFR, color/HDR, audio y fecha de grabación. */
export async function sondear(ruta: string): Promise<Sondeo> {
	return interpretarSondeo(await ffprobeJson(ruta), ruta);
}

/**
 * ¿El crudo se puede editar tal cual? Falla con código 2 (te pregunto) si:
 * - es HDR: la conversión HDR→SDR (scale_vt) se valida el día que aparezca un clip HLG;
 * - no trae audio: sin voz no hay transcripción ni cortes.
 */
export function revisarApto(sondeo: Sondeo): void {
	const nombre = basename(sondeo.ruta);
	if (sondeo.video.hdr) {
		const tipo = sondeo.video.colorTransfer === 'arib-std-b67' ? 'HLG' : 'PQ';
		throw fallo(
			`preparar ${nombre}`,
			`es un video HDR (${tipo}, ${sondeo.video.colorTransfer}) y la conversión a SDR todavía no está validada`,
			'dime si lo convierto de todos modos o vuelve a grabar con Video HDR apagado (Ajustes > Cámara > Grabar video)',
			2,
		);
	}
	if (!sondeo.audio) {
		throw fallo(`preparar ${nombre}`, 'no trae pista de audio y sin voz no hay transcripción ni cortes', 'usa la toma original con su audio', 2);
	}
}

export type OpcionesFfmpeg = {
	/** Qué se intentaba, para el mensaje "No pude <que>: …". */
	que: string;
	/** Duración esperada de la salida (s), para calcular el avance con `-progress pipe:1`. */
	duracionTotal?: number;
	alProgreso?: (fraccion: number) => void;
};

/**
 * Corre ffmpeg sin shell (los argumentos van tal cual, con espacios y todo).
 * Si falla: código 2 si no está instalado, código 1 si terminó con error (el stderr va al log, no al chat).
 */
export function correrFfmpeg(args: string[], opciones: OpcionesFfmpeg): Promise<void> {
	return new Promise<void>((resolver, rechazar) => {
		const hijo = spawn('ffmpeg', args, {stdio: ['ignore', 'pipe', 'pipe']});
		let errores = '';
		let pendiente = '';
		hijo.stderr.on('data', (trozo: Buffer) => {
			errores = (errores + trozo.toString()).slice(-8000);
		});
		hijo.stdout.on('data', (trozo: Buffer) => {
			pendiente += trozo.toString();
			const lineas = pendiente.split('\n');
			pendiente = lineas.pop() ?? '';
			if (!opciones.alProgreso || !opciones.duracionTotal) return;
			for (const linea of lineas) {
				const m = /^out_time_us=(\d+)/.exec(linea.trim());
				if (m) opciones.alProgreso(Math.min(1, Number(m[1]) / 1e6 / opciones.duracionTotal));
			}
		});
		hijo.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				rechazar(fallo(opciones.que, 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú) y vuelve a intentar', 2, error));
			} else {
				rechazar(fallo(opciones.que, `no pude arrancar ffmpeg (${error.message})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, error));
			}
		});
		hijo.on('close', (codigo, senal) => {
			if (codigo === 0) {
				resolver();
				return;
			}
			const ultima = errores.trim().split('\n').pop()?.trim() || (senal ? `señal ${senal}` : `código ${codigo}`);
			rechazar(fallo(opciones.que, `ffmpeg terminó con error (${ultima})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: errores}));
		});
	});
}

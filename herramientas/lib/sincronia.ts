// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Sincronía de los subtítulos contra la VERDAD DE CONSENSO (decisión del estilo, tomada después de ver
 * los resultados de la Fase 0).
 *
 * Arranque de consenso = el final de una pausa según ffmpeg silencedetect (n = −35 dB, d = 0.25 s) que
 * coincide a ±25 ms con el arranque por flujo espectral. El flujo es EXACTAMENTE el de
 * pruebas/integracion/compuerta-energia.ts (aspectralstats, flux, Hann de 256 muestras con solape 0.875 → un
 * valor cada 2 ms a 16 kHz; arranque = primer cuadro después de la mitad de la pausa con flujo ≥ mediana del
 * flujo dentro de la pausa (sin 50 ms en cada borde) + 20 dB, buscando hasta 1 s después del fin de la pausa).
 * La única diferencia: aquí el flujo además tiene que ser > 0, para que el silencio digital (flujo 0, como en
 * un audio sintético o renderizado) no cuente como arranque. En grabaciones reales el flujo nunca es 0.
 *
 * Por cada arranque de consenso:
 *  - la primera palabra tras la pausa = la primera palabra (de los subtítulos) cuyo inicio cae después de la
 *    mitad de la pausa (la regla de emparejar() de la compuerta; si dos pausas dan la misma palabra, cuenta la
 *    última);
 *  - el subtítulo = el de `desde` más cercano al arranque, y solo cuenta si empieza con esa palabra;
 *  - error = desde_subtítulo − arranque (ms), medido en la línea de tiempo de la base (la que ve quien mira).
 * Se reporta N, p50 y p95 de |error|, la mediana con signo y el % dentro de −67…+45 ms.
 * Criterio de la Fase 1: p50 ≤ 25 ms y p95 ≤ 45 ms. Con N < 10 el criterio queda N/A (muestra muy chica).
 *
 * Fuentes del audio que se mide:
 *  - "base": el audio de la base de la EDL (lo que suena debajo de los subtítulos).
 *  - "final": el audio del MP4 final (lleva SFX y loudnorm: un SFX dentro de una pausa crea arranques falsos).
 *  - "original": audio16k.wav del crudo + los tramos de la base (manifest). Los arranques se buscan en el
 *    crudo y se pasan a la base con remapear(); un arranque que cae en un corte no cuenta. Existe porque, con los
 *    pads del plan (60–100 ms antes y 100–150 ms después), cada corte deja 160–250 ms de silencio, por debajo de
 *    los 250 ms que exige silencedetect: se espera que la base cortada deje pocos arranques (todavía no se ha
 *    medido con una base cortada real; qa.ts reporta las dos cifras para comprobarlo).
 *    Si la base va acelerada (manifest → etapas.base.parametros.velocidad = F), el mapeo también divide entre F:
 *    arranque en la base = (inicio de su tramo en la base sin acelerar + (t − desde del tramo)) / F. El criterio
 *    (p50 ≤ 25 ms, p95 ≤ 45 ms, N ≥ 10) se mide igual, en la línea de tiempo de la base ya acelerada.
 */
import {spawnSync} from 'node:child_process';
import {fallo} from './fallo.ts';
import {aCrudo, duracionBase, remapear, type Tramo} from './remapear.ts';

export const SINCRONIA = {
	silencedetect: {umbral: '-35dB', duracionMinS: 0.25},
	flujo: {ventana: 256, solape: 0.875, sobreMedianaDb: 20, margenPausaS: 0.05, buscarHastaS: 1.0, minimoDentro: 5},
	/** Las dos verdades tienen que coincidir a ±25 ms. */
	consensoMs: 25,
	/** Una pausa que termina a menos de esto del final del audio no la sigue ninguna palabra. */
	finalAudioS: 0.05,
	criterio: {p50_ms: 25, p95_ms: 45},
	ventanaMs: [-67, 45] as const,
	/** Por debajo de este N el criterio queda N/A. */
	nMinimo: 10,
	/** Frecuencia del audio que se analiza (la de los fixtures de la Fase 0 y de audio16k.wav). */
	frecuencia: 16000,
} as const;

export type FuenteSincronia = 'base' | 'final' | 'original';

export type Pausa = {inicio: number; fin: number};

export type Flujo = {
	/** pts de cada cuadro de análisis (s). */
	t: Float64Array;
	valor: Float64Array;
};

/** Percentil con interpolación lineal entre rangos (igual que la compuerta de la Fase 0). */
export function percentil(valores: readonly number[], q: number): number {
	const orden = [...valores].sort((a, b) => a - b);
	if (orden.length === 0) return Number.NaN;
	const pos = (orden.length - 1) * q;
	const bajo = Math.floor(pos);
	const alto = Math.min(bajo + 1, orden.length - 1);
	return orden[bajo] + (orden[alto] - orden[bajo]) * (pos - bajo);
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ───────────────────────── parseo de ffmpeg (puro) ─────────────────────────

/** Pausas de la salida (stderr) de silencedetect: cada "silence_end: X | silence_duration: Y". */
export function parsearSilencios(stderr: string): Pausa[] {
	const pausas: Pausa[] = [];
	for (const m of stderr.matchAll(/silence_end: (-?[\d.]+) \| silence_duration: ([\d.]+)/g)) {
		const fin = Number(m[1]);
		const duracion = Number(m[2]);
		if (Number.isFinite(fin) && Number.isFinite(duracion)) pausas.push({inicio: fin - duracion, fin});
	}
	return pausas;
}

/** Serie de flujo de la salida de ametadata (mode=print) de aspectralstats: "pts_time:…" y luego "…flux=…". */
export function parsearFlujo(stdout: string): Flujo {
	const t: number[] = [];
	const valor: number[] = [];
	let pts: number | null = null;
	for (const linea of stdout.split('\n')) {
		const m = /pts_time:(-?[\d.e+-]+)/.exec(linea);
		if (m) {
			pts = Number(m[1]);
			continue;
		}
		const v = /aspectralstats\.1\.flux=(.+)$/.exec(linea);
		if (v && pts !== null) {
			t.push(pts);
			valor.push(Number(v[1]));
			pts = null;
		}
	}
	return {t: Float64Array.from(t), valor: Float64Array.from(valor)};
}

// ───────────────────────── verdad de consenso (pura) ─────────────────────────

type OpcionesFlujo = {sobreMedianaDb?: number; margenPausaS?: number; buscarHastaS?: number};

/**
 * Arranque por flujo espectral en una pausa (ms), o null si la pausa es muy corta para medir su mediana
 * o no aparece flujo suficiente hasta 1 s después.
 */
export function arranquePorFlujo(f: Flujo, pausa: Pausa, opciones: OpcionesFlujo = {}): number | null {
	const sobreDb = opciones.sobreMedianaDb ?? SINCRONIA.flujo.sobreMedianaDb;
	const margen = opciones.margenPausaS ?? SINCRONIA.flujo.margenPausaS;
	const buscarHasta = opciones.buscarHastaS ?? SINCRONIA.flujo.buscarHastaS;
	const dentro: number[] = [];
	for (let i = 0; i < f.t.length; i++) {
		if (f.t[i] >= pausa.inicio + margen && f.t[i] <= pausa.fin - margen) dentro.push(f.valor[i]);
	}
	if (dentro.length < SINCRONIA.flujo.minimoDentro) return null;
	const umbral = percentil(dentro, 0.5) * 10 ** (sobreDb / 20);
	const mitad = (pausa.inicio + pausa.fin) / 2;
	for (let i = 0; i < f.t.length; i++) {
		if (f.t[i] < mitad) continue;
		if (f.t[i] > pausa.fin + buscarHasta) break;
		if (f.valor[i] >= umbral && f.valor[i] > 0) return Math.round(f.t[i] * 1e6) / 1000;
	}
	return null;
}

export type Arranque = {
	pausa: Pausa;
	/** Fin de la pausa según silencedetect (ms): es el arranque que se usa como verdad. */
	silencioMs: number;
	flujoMs: number | null;
	consenso: boolean;
};

/** Un arranque por pausa (salvo las que terminan con el audio), con su arranque por flujo y si hay consenso. */
export function arranquesDeConsenso(pausas: readonly Pausa[], flujo: Flujo, duracionS: number, consensoMs: number = SINCRONIA.consensoMs): Arranque[] {
	return pausas
		.filter((p) => p.fin < duracionS - SINCRONIA.finalAudioS)
		.map((pausa) => {
			const silencioMs = Math.round(pausa.fin * 1e6) / 1000;
			const flujoMs = arranquePorFlujo(flujo, pausa);
			return {pausa, silencioMs, flujoMs, consenso: flujoMs !== null && Math.abs(silencioMs - flujoMs) <= consensoMs};
		});
}

// ───────────────────────── emparejado con los subtítulos (puro) ─────────────────────────

export type PalabraSinc = {i: number; t: string; d: number; h: number};
export type SubtituloSinc = {id: string; desde: number; hasta: number; palabras: readonly PalabraSinc[]};

/**
 * Cómo se pasa entre la línea de tiempo del audio medido ("referencia") y la de la base.
 * Para la base o el final es la identidad; para el original, remapear()/aCrudo() con los tramos de la base.
 */
export type Mapeo = {
	/** Referencia → base; null si cae en un corte. */
	aBase: (tRef: number) => number | null;
	/** Base → referencia. */
	aRef: (tBase: number) => number;
};

export const MAPEO_IDENTIDAD: Mapeo = {aBase: (t) => t, aRef: (t) => t};

/**
 * Mapeo crudo ↔ base a partir de los tramos de la base en cuadros de 30 fps ([inicio, fin) del crudo, del manifest)
 * y de la velocidad F con que base.ts aceleró la base (1 = sin acelerar).
 */
export function mapeoDesdeTramos(tramosCuadros: ReadonlyArray<readonly [number, number]>, velocidad = 1): Mapeo {
	const keep: Tramo[] = tramosCuadros.map(([a, b]) => ({desde: a / 30, hasta: b / 30}));
	const fin = duracionBase(keep, velocidad);
	// Una palabra de la EDL nunca debería pasar del final de la base; si pasa, se recorta en vez de tumbar la QA.
	return {aBase: (t) => remapear(keep, t, velocidad), aRef: (t) => aCrudo(keep, Math.min(Math.max(0, t), fin), velocidad)};
}

export const MOTIVOS_EXCLUSION = {
	sinConsenso: 'silencedetect y el flujo no coinciden a ±25 ms',
	enCorte: 'el arranque cae en un tramo que se cortó',
	sinPalabra: 'no hay palabra de subtítulo después de la pausa',
	palabraRepetida: 'otra pausa posterior cae en la misma palabra (cuenta la última)',
	noEmpieza: 'el subtítulo más cercano no empieza con la primera palabra tras la pausa',
} as const;
export type MotivoExclusion = keyof typeof MOTIVOS_EXCLUSION;

export type ParSinc = {
	subtitulo: string;
	palabra: string;
	/** Arranque de consenso (silencedetect) en la base y en la referencia (s). */
	arranque_s: number;
	arranque_ref_s: number;
	flujo_ref_s: number;
	desde_s: number;
	/** desde_subtítulo − arranque (ms). Es el número del criterio. */
	error_ms: number;
	/** Inicio de la primera palabra − arranque (ms); diagnóstico (el subtítulo puede adelantarse a propósito). */
	error_palabra_ms: number;
	/** El cuadro en que de verdad aparece (round(desde × 30)) − arranque (ms); diagnóstico. */
	error_cuadro_ms: number;
};

export type Emparejado = {pares: ParSinc[]; excluidos: Record<MotivoExclusion, number>};

/** Empareja cada arranque de consenso con su subtítulo (ver las reglas en el encabezado). */
export function emparejarSubtitulos(arranques: readonly Arranque[], subtitulos: readonly SubtituloSinc[], mapeo: Mapeo = MAPEO_IDENTIDAD): Emparejado {
	const excluidos: Record<MotivoExclusion, number> = {sinConsenso: 0, enCorte: 0, sinPalabra: 0, palabraRepetida: 0, noEmpieza: 0};
	const subs = [...subtitulos].sort((a, b) => a.desde - b.desde);
	// Todas las palabras, en orden, con su inicio en la línea de tiempo de la referencia.
	const palabras = subs
		.flatMap((s, si) => s.palabras.map((p, pos) => ({si, pos, p, dRef: mapeo.aRef(p.d)})))
		.sort((a, b) => a.dRef - b.dRef || a.si - b.si || a.pos - b.pos);

	// Primero la palabra de cada arranque (si dos pausas caen en la misma palabra, gana la última).
	const porPalabra = new Map<number, {a: Arranque; tBase: number}>();
	for (const a of arranques) {
		if (!a.consenso) {
			excluidos.sinConsenso++;
			continue;
		}
		const tBase = mapeo.aBase(a.silencioMs / 1000);
		if (tBase === null) {
			excluidos.enCorte++;
			continue;
		}
		const mitad = (a.pausa.inicio + a.pausa.fin) / 2;
		const j = palabras.findIndex((w) => w.dRef >= mitad);
		if (j < 0) {
			excluidos.sinPalabra++;
			continue;
		}
		if (porPalabra.has(j)) excluidos.palabraRepetida++;
		porPalabra.set(j, {a, tBase});
	}

	const pares: ParSinc[] = [];
	for (const [j, {a, tBase}] of [...porPalabra.entries()].sort((x, y) => x[0] - y[0])) {
		const w = palabras[j];
		let cercano = 0;
		for (let k = 1; k < subs.length; k++) {
			if (Math.abs(subs[k].desde - tBase) < Math.abs(subs[cercano].desde - tBase)) cercano = k;
		}
		if (cercano !== w.si || w.pos !== 0) {
			excluidos.noEmpieza++;
			continue;
		}
		const s = subs[cercano];
		pares.push({
			subtitulo: s.id,
			palabra: w.p.t,
			arranque_s: r3(tBase),
			arranque_ref_s: r3(a.silencioMs / 1000),
			flujo_ref_s: r3((a.flujoMs as number) / 1000),
			desde_s: s.desde,
			error_ms: r1((s.desde - tBase) * 1000),
			error_palabra_ms: r1((w.p.d - tBase) * 1000),
			error_cuadro_ms: r1((Math.round(s.desde * 30) / 30 - tBase) * 1000),
		});
	}
	return {pares, excluidos};
}

export type EstadisticaSinc = {
	N: number;
	p50_ms: number | null;
	p95_ms: number | null;
	mediana_error_ms: number | null;
	ventana95_ms: [number, number] | null;
	/** % de errores dentro de −67…+45 ms (0–100). */
	dentro_pct: number | null;
	ventana_ms: readonly [number, number];
	/** true/false con N ≥ nMinimo; null (N/A) con menos. */
	pasa: boolean | null;
	nota?: string;
};

/** p50/p95 de |error|, mediana con signo, % en la ventana y el veredicto del criterio. */
export function estadisticaSincronia(errores: readonly number[], nMinimo: number = SINCRONIA.nMinimo): EstadisticaSinc {
	const N = errores.length;
	const [a, b] = SINCRONIA.ventanaMs;
	if (N === 0) {
		return {N, p50_ms: null, p95_ms: null, mediana_error_ms: null, ventana95_ms: null, dentro_pct: null, ventana_ms: SINCRONIA.ventanaMs, pasa: null, nota: 'no hubo ningún arranque de consenso emparejado con un subtítulo'};
	}
	const abs = errores.map(Math.abs);
	const p50 = r1(percentil(abs, 0.5));
	const p95 = r1(percentil(abs, 0.95));
	const est: EstadisticaSinc = {
		N,
		p50_ms: p50,
		p95_ms: p95,
		mediana_error_ms: r1(percentil(errores, 0.5)),
		ventana95_ms: [r1(percentil(errores, 0.025)), r1(percentil(errores, 0.975))],
		dentro_pct: r1((errores.filter((e) => e >= a && e <= b).length / N) * 100),
		ventana_ms: SINCRONIA.ventanaMs,
		pasa: N >= nMinimo ? p50 <= SINCRONIA.criterio.p50_ms && p95 <= SINCRONIA.criterio.p95_ms : null,
	};
	if (N < nMinimo) est.nota = `N = ${N} es menor que ${nMinimo}: el p95 no es estable y el criterio queda N/A`;
	return est;
}

// ───────────────────────── ffmpeg ─────────────────────────

function correrFfmpegSincrono(args: string[], que: string, salida: 'stdout' | 'stderr'): string {
	const r = spawnSync('ffmpeg', args, {encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024});
	if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
		throw fallo(que, 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú) y vuelve a intentar', 2);
	}
	if (r.status !== 0) {
		throw fallo(que, `ffmpeg salió con código ${r.status ?? r.signal}`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: r.stderr?.slice(-3000)});
	}
	return salida === 'stdout' ? r.stdout : r.stderr;
}

/** Pausas de un WAV con silencedetect (n = −35 dB, d = 0.25 s). */
export function medirSilencios(rutaWav: string): Pausa[] {
	const {umbral, duracionMinS} = SINCRONIA.silencedetect;
	const stderr = correrFfmpegSincrono(
		['-nostdin', '-hide_banner', '-nostats', '-i', rutaWav, '-af', `silencedetect=n=${umbral}:d=${duracionMinS}`, '-f', 'null', '-'],
		'medir los silencios',
		'stderr',
	);
	return parsearSilencios(stderr);
}

/** Flujo espectral de un WAV (aspectralstats, flux; mismos parámetros que la compuerta de la Fase 0). */
export function medirFlujo(rutaWav: string): Flujo {
	const {ventana, solape} = SINCRONIA.flujo;
	// file='pipe\:1' escribe al stdout heredado. La compuerta de la Fase 0 usó file=/dev/stdout, que da lo mismo
	// pero dentro del sandbox de macOS no se puede abrir por ruta ("Operation not permitted").
	const filtro = `aspectralstats=win_size=${ventana}:overlap=${solape}:win_func=hann:measure=flux,ametadata=mode=print:key=lavfi.aspectralstats.1.flux:file='pipe\\:1'`;
	const stdout = correrFfmpegSincrono(['-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error', '-i', rutaWav, '-af', filtro, '-f', 'null', '-'], 'medir el flujo espectral', 'stdout');
	const f = parsearFlujo(stdout);
	if (f.t.length === 0) {
		throw fallo('medir el flujo espectral', 'ffmpeg no devolvió valores de flux', 'confirma que tu ffmpeg trae el filtro aspectralstats (ffmpeg ≥ 5)', 1);
	}
	return f;
}

/** Duración (s) de un WAV PCM según ffprobe. */
function duracionAudio(ruta: string): number {
	const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', ruta], {encoding: 'utf8'});
	const d = Number(r.stdout?.trim());
	if (r.status !== 0 || !Number.isFinite(d)) {
		throw fallo('leer la duración del audio', `ffprobe no pudo leer ${ruta}`, 'revisa que el archivo exista y esté completo', 1, {stderr: r.stderr});
	}
	return d;
}

/**
 * Extrae el audio de un video a WAV PCM 16 kHz mono (la misma receta de audio16k.wav de la ingesta,
 * alineado a pts 0 con aresample=async=1:first_pts=0).
 */
export function extraerAudio16k(video: string, salida: string): void {
	correrFfmpegSincrono(
		['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-map', '0:a:0', '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(SINCRONIA.frecuencia), '-c:a', 'pcm_s16le', '-f', 'wav', salida],
		'extraer el audio para medir la sincronía',
		'stderr',
	);
}

export type ResultadoSincronia = EstadisticaSinc & {
	fuente: FuenteSincronia;
	audio: string;
	duracion_s: number;
	verdad: string;
	pausas: number;
	arranques: number;
	consenso: number;
	excluidos: Record<MotivoExclusion, number>;
	pares: ParSinc[];
	peores: ParSinc[];
	segundos: number;
};

export const DESCRIPCION_VERDAD =
	`consenso: fin de pausa de silencedetect (n=${SINCRONIA.silencedetect.umbral}, d=${SINCRONIA.silencedetect.duracionMinS} s) que coincide a ±${SINCRONIA.consensoMs} ms ` +
	`con el arranque por flujo espectral (aspectralstats flux, Hann ${SINCRONIA.flujo.ventana} muestras a 16 kHz, +${SINCRONIA.flujo.sobreMedianaDb} dB sobre la mediana de la pausa)`;

/**
 * Mide la sincronía de los subtítulos sobre un WAV de 16 kHz mono (ver el encabezado del módulo).
 * `mapeo` pasa los tiempos del WAV a la base (identidad si el WAV ya es de la base o del final).
 */
export function medirSincronia(opciones: {
	audio16k: string;
	subtitulos: readonly SubtituloSinc[];
	fuente: FuenteSincronia;
	mapeo?: Mapeo;
	nMinimo?: number;
}): ResultadoSincronia {
	const t0 = performance.now();
	const duracion = duracionAudio(opciones.audio16k);
	const pausas = medirSilencios(opciones.audio16k);
	const flujo = medirFlujo(opciones.audio16k);
	const arranques = arranquesDeConsenso(pausas, flujo, duracion);
	const {pares, excluidos} = emparejarSubtitulos(arranques, opciones.subtitulos, opciones.mapeo ?? MAPEO_IDENTIDAD);
	const est = estadisticaSincronia(
		pares.map((p) => p.error_ms),
		opciones.nMinimo,
	);
	return {
		...est,
		fuente: opciones.fuente,
		audio: opciones.audio16k,
		duracion_s: r3(duracion),
		verdad: DESCRIPCION_VERDAD,
		pausas: pausas.length,
		arranques: arranques.length,
		consenso: arranques.filter((a) => a.consenso).length,
		excluidos,
		pares,
		peores: [...pares].sort((a, b) => Math.abs(b.error_ms) - Math.abs(a.error_ms)).slice(0, 5),
		segundos: r3((performance.now() - t0) / 1000),
	};
}

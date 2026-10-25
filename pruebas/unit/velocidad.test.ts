// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de la VELOCIDAD de la base (×F, como tú aceleras tus reels: ×1.05–×1.15, mediana ×1.096 en tus 4 pares).
 *
 * - lib/remapear.ts con F: duración = Σkeep / F, remapeo de puntos e intervalos, inversa y bordes de tramo exactos
 *   (los mismos que calculan cortes.ts y subtitulos.ts); con F = 1, bit a bit lo de siempre.
 * - lib/sincronia.ts: el mapeo crudo ↔ base con F (la verdad de consenso se mide en el crudo y se divide entre F).
 * - base.ts: de dónde sale F (cortes.json manda; --velocidad distinta → código 2), el filtro (idéntico a ×1 cuando
 *   F = 1; un solo atempo; cuadros exactos por tramo) y de punta a punta con ffmpeg real sobre un clip sintético
 *   cuyo cuadro k lleva luma 16 + 4·(k mod 50): cuadros = round(Σ/F × 30), audio = video, cada corte en el cuadro que
 *   espera subtitulos.ts (también con un empate en medio cuadro, F = 1.2), el contenido de cada cuadro, el tono de
 *   440 Hz sin cambio (control: asetrate sí lo sube) y los pitidos del audio donde dice el remapeo (cada uno a ±15 ms,
 *   la mediana a ±8 ms; sobre un piso de ruido como el de una grabación real).
 * - cortes.ts: F por defecto de calibracion-cortes.json (solo si está marcada consistente), cortes.json y
 *   transcripcion-base.json con F y tiempos divididos entre F.
 * - subtitulos.ts: bordes de tramo con F y código 2 si la base del manifest es de otra velocidad.
 * - qa.ts: la velocidad de la base entra al mapeo de la sincronía.
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {
	construirFiltro,
	cuadrosDeCortes,
	cuadrosDeLaBase,
	generarBase,
	leerCortes,
	leerCortesConVelocidad,
	resolverVelocidad,
	tramosEnLaBase,
	velocidadDeArgumento,
	type TramoCuadros,
} from '../../herramientas/base.ts';
import {
	armarTranscripcionBase,
	ejecutarCortes,
	leerCalibracionCortes,
	leerVelocidadPreferida,
	resolverVelocidadCortes,
	velocidadDeTexto,
	type Palabra,
} from '../../herramientas/cortes.ts';
import {ingerir} from '../../herramientas/ingesta.ts';
import {escribirWav} from '../../herramientas/lib/energia.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {leerManifest, registrarEtapa} from '../../herramientas/lib/manifest.ts';
import {aCrudo, cuantizar, duracionBase, FPS, remapear, remapearIntervalo, VELOCIDAD_MAX, VELOCIDAD_MIN, type Tramo} from '../../herramientas/lib/remapear.ts';
import {emparejarSubtitulos, mapeoDesdeTramos, SINCRONIA, type Arranque} from '../../herramientas/lib/sincronia.ts';
import {prepararSincronia, velocidadDeLaBase} from '../../herramientas/qa.ts';
import {generarSubtitulos, tramosEnBase} from '../../herramientas/subtitulos.ts';
import {edicionVacia} from '../../src/esquema/edicion.ts';
import {HAY_FUENTES} from './requisitos.ts';

const tmp = mkdtempSync(join(tmpdir(), 'velocidad-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

const FORMATO = /^No pude [^:\n]+: [^\n]+\. Siguiente paso: [^\n]+\.$/;

function falloDe(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

async function falloAsync(promesa: Promise<unknown>): Promise<FalloEditor> {
	try {
		await promesa;
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

/** Generador con semilla fija (mulberry32). */
function azarConSemilla(semilla: number): () => number {
	let a = semilla >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** keep[] al azar: 20 tramos de 1 a 120 cuadros, con cortes de 1 a 60 cuadros entre ellos. */
function keepAlAzar(azar: () => number): Tramo[] {
	const keep: Tramo[] = [];
	let cuadro = Math.floor(azar() * 40);
	for (let i = 0; i < 20; i++) {
		const largo = 1 + Math.floor(azar() * 120);
		keep.push({desde: cuantizar(cuadro / FPS), hasta: cuantizar((cuadro + largo) / FPS)});
		cuadro += largo + 1 + Math.floor(azar() * 60);
	}
	return keep;
}

/**
 * Crudo de 10 s con 3 tramos que se quedan (los de pruebas/unit/remapear.test.ts):
 *   crudo [1, 2) → base sin acelerar [0, 1) · crudo [3, 5) → [1, 3) · crudo [7.5, 8) → [3, 3.5)
 */
const KEEP: Tramo[] = [
	{desde: 1, hasta: 2},
	{desde: 3, hasta: 5},
	{desde: 7.5, hasta: 8},
];

// ───────────────────────── lib/remapear.ts ─────────────────────────

describe('lib/remapear.ts con velocidad F', () => {
	it('duración = Σkeep / F', () => {
		expect(duracionBase(KEEP, 1.25)).toBeCloseTo(3.5 / 1.25, 12);
		expect(duracionBase(KEEP, 1.15)).toBeCloseTo(3.5 / 1.15, 12);
		expect(duracionBase(KEEP, 0.8)).toBeCloseTo(3.5 / 0.8, 12);
	});

	it('un punto del crudo cae en (inicio del tramo sin acelerar + (t − desde)) / F', () => {
		expect(remapear(KEEP, 3.2, 1.25)).toBeCloseTo((1 + 0.2) / 1.25, 12);
		expect(remapear(KEEP, 1, 1.15)).toBe(0);
		expect(remapear(KEEP, 7.5, 1.15)).toBeCloseTo(3 / 1.15, 12);
		expect(remapear(KEEP, 2.5, 1.15)).toBeNull(); // en un corte
	});

	it('la inversa regresa al mismo tiempo del crudo', () => {
		for (const F of [1.05, 1.0963, 1.15, 1.5, 0.8]) {
			for (const t of [1, 1.4, 1.999, 3, 4.5, 7.6, 7.99]) {
				expect(aCrudo(KEEP, remapear(KEEP, t, F)!, F)).toBeCloseTo(t, 9);
			}
			expect(aCrudo(KEEP, duracionBase(KEEP, F), F)).toBe(8); // el final exacto da el hasta del último tramo
		}
	});

	it('un intervalo que cruza un corte se recorta a su tramo y los dos bordes se dividen entre F', () => {
		const r = remapearIntervalo(KEEP, 4.8, 5.4, 1.2)!; // 0.2 s en el tramo 1, 0.4 s en el corte
		expect(r.tramo).toBe(1);
		expect(r.desde).toBeCloseTo((1 + 1.8) / 1.2, 12);
		expect(r.hasta).toBe(duracionBase(KEEP.slice(0, 2), 1.2));
		const dentro = remapearIntervalo(KEEP, 3.5, 3.9, 1.2)!;
		expect(dentro.hasta - dentro.desde).toBeCloseTo(0.4 / 1.2, 12);
	});

	it('con F = 1 da exactamente (bit a bit) lo mismo que sin velocidad', () => {
		const azar = azarConSemilla(3);
		const keep = keepAlAzar(azar);
		expect(duracionBase(keep, 1)).toBe(duracionBase(keep));
		for (let k = 0; k < 300; k++) {
			const t = azar() * (keep.at(-1)!.hasta + 1);
			expect(remapear(keep, t, 1)).toBe(remapear(keep, t));
			const b = t + azar() * 2;
			expect(remapearIntervalo(keep, t, b, 1)).toEqual(remapearIntervalo(keep, t, b));
			const tb = azar() * duracionBase(keep);
			expect(aCrudo(keep, tb, 1)).toBe(aCrudo(keep, tb));
		}
	});

	it('propiedad (semilla fija): cada tiempo queda dentro de su tramo en la base, en orden, y la inversa cierra', () => {
		const azar = azarConSemilla(11);
		for (const F of [1.05, 1.0963, 1.15, 1.2, 1.5, 0.8]) {
			const keep = keepAlAzar(azar);
			const bordes = keep.map((_, k) => [k === 0 ? 0 : duracionBase(keep.slice(0, k), F), duracionBase(keep.slice(0, k + 1), F)]);
			let previo = -1;
			for (let k = 0; k < 400; k++) {
				const i = Math.floor(azar() * keep.length);
				const t = keep[i].desde + azar() * (keep[i].hasta - keep[i].desde);
				const tb = remapear(keep, t, F)!;
				expect(tb).toBeGreaterThanOrEqual(bordes[i][0]);
				expect(tb).toBeLessThan(bordes[i][1]);
				expect(tb).toBeCloseTo(remapear(keep, t)! / F, 9);
				expect(aCrudo(keep, tb, F)).toBeCloseTo(t, 9);
				previo = Math.max(previo, tb);
			}
			// Los bordes de cada tramo son exactamente los que se piden a remapear (sin sumar segundos).
			keep.forEach((tr, i) => expect(remapear(keep, tr.desde, F)).toBe(bordes[i][0]));
		}
	});

	it.each([0.4, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 0])('una velocidad %s fuera de %s–%s sale con código 1', (F) => {
		const e = falloDe(() => duracionBase(KEEP, F));
		expect(e.codigo).toBe(1);
		expect(e.message).toMatch(FORMATO);
		expect(falloDe(() => remapear(KEEP, 1.5, F)).codigo).toBe(1);
		expect(falloDe(() => aCrudo(KEEP, 0.5, F)).codigo).toBe(1);
	});

	it('el rango es el de un solo atempo de ffmpeg', () => {
		expect([VELOCIDAD_MIN, VELOCIDAD_MAX]).toEqual([0.5, 2]);
	});
});

// ───────────────────────── lib/sincronia.ts ─────────────────────────

describe('sincronía: la verdad del crudo se pasa a la base con los tramos y F', () => {
	const tramos: Array<[number, number]> = [
		[0, 60],
		[90, 180],
	];

	it('mapeoDesdeTramos divide entre F (crudo 3.2 s → base (2 + 0.2) / 1.25)', () => {
		const m = mapeoDesdeTramos(tramos, 1.25);
		expect(m.aBase(3.2)).toBeCloseTo(2.2 / 1.25, 12);
		expect(m.aBase(2.5)).toBeNull();
		expect(m.aRef(2.2 / 1.25)).toBeCloseTo(3.2, 9);
		expect(m.aRef(99)).toBe(6); // se recorta al final de la base
		const sin = mapeoDesdeTramos(tramos);
		expect(sin.aBase(3.2)).toBeCloseTo(2.2, 12);
	});

	it('el error se mide en la base acelerada: un subtítulo en el lugar correcto da 0 ms', () => {
		const F = 1.15;
		const mapeo = mapeoDesdeTramos(tramos, F);
		const arranque: Arranque = {pausa: {inicio: 2.1, fin: 3.2}, silencioMs: 3200, flujoMs: 3195, consenso: true};
		const desde = 2.2 / F;
		const subs = [{id: 's1', desde: 0.5 / F, hasta: 0.9 / F, palabras: [{i: 0, t: 'uno', d: 0.5 / F, h: 0.9 / F}]}, {id: 's2', desde, hasta: desde + 0.3, palabras: [{i: 1, t: 'dos', d: desde, h: desde + 0.3}]}];
		const {pares} = emparejarSubtitulos([arranque], subs, mapeo);
		expect(pares).toHaveLength(1);
		expect(pares[0].subtitulo).toBe('s2');
		expect(Math.abs(pares[0].error_ms)).toBeLessThan(0.5);
		expect(pares[0].arranque_ref_s).toBe(3.2);
		// Sin dividir entre F, ese arranque caería 287 ms después: la velocidad sí importa para el criterio.
		expect((mapeoDesdeTramos(tramos).aBase(3.2)! - mapeo.aBase(3.2)!) * 1000).toBeGreaterThan(SINCRONIA.criterio.p95_ms);
	});
});

// ───────────────────────── base.ts (puro) ─────────────────────────

describe('base.ts: de dónde sale la velocidad', () => {
	const conCortes = (velocidad: number | null) => ({ruta: join(tmp, 'cortes.json'), velocidad});

	it('con cortes.json manda su velocidad; uno de antes de la velocidad va a ×1', () => {
		expect(resolverVelocidad(undefined, conCortes(1.15))).toEqual({factor: 1.15, origen: 'cortes.json'});
		expect(resolverVelocidad(1.15, conCortes(1.15)).factor).toBe(1.15);
		expect(resolverVelocidad(undefined, conCortes(null)).factor).toBe(1);
		expect(resolverVelocidad(1, conCortes(null)).factor).toBe(1);
	});

	it('pedir otra velocidad que la de cortes.json sale con código 2 (los subtítulos se desfasarían)', () => {
		const e = falloDe(() => resolverVelocidad(1.2, conCortes(1.15), '_x'));
		expect(e.codigo).toBe(2);
		expect(e.message).toMatch(FORMATO);
		expect(e.message).toContain('cortes.ts');
		expect(e.message).toContain('--velocidad 1.2');
		expect(falloDe(() => resolverVelocidad(1.15, conCortes(null))).codigo).toBe(2);
	});

	it('sin cortes.json (el clip entero): --velocidad o ×1', () => {
		expect(resolverVelocidad(undefined, null).factor).toBe(1);
		expect(resolverVelocidad(1.1, null)).toEqual({factor: 1.1, origen: '--velocidad'});
	});

	it('una velocidad fuera de 0.5–2 sale con código 2 (argumento y cortes.json)', () => {
		expect(falloDe(() => resolverVelocidad(2.5, null)).codigo).toBe(2);
		for (const malo of ['0', '3', 'rápido', '', '1,1']) expect(falloDe(() => velocidadDeArgumento(malo)).codigo).toBe(2);
		expect(velocidadDeArgumento('1.15')).toBe(1.15);
		expect(velocidadDeArgumento(undefined)).toBeUndefined();
		const ruta = join(tmp, 'cortes-velocidad.json');
		writeFileSync(ruta, JSON.stringify({keep: [{desde: 1, hasta: 2}], velocidad: 1.15}));
		expect(leerCortesConVelocidad(ruta)).toEqual({keep: [{desde: 1, hasta: 2}], velocidad: 1.15});
		expect(leerCortes(ruta)).toEqual([{desde: 1, hasta: 2}]); // la lectura de siempre no cambia
		writeFileSync(ruta, JSON.stringify({keep: [{desde: 1, hasta: 2}]}));
		expect(leerCortesConVelocidad(ruta).velocidad).toBeNull();
		for (const v of [5, '1.1', null]) {
			writeFileSync(ruta, JSON.stringify({keep: [{desde: 1, hasta: 2}], velocidad: v}));
			const e = falloDe(() => leerCortesConVelocidad(ruta));
			expect(e.codigo).toBe(2);
			expect(e.message).toMatch(FORMATO);
		}
	});
});

describe('base.ts: filtro y cuadros con velocidad', () => {
	const tramos: TramoCuadros[] = [
		{inicio: 15, fin: 48},
		{inicio: 60, fin: 75},
		{inicio: 78, fin: 105},
	];

	it('con F = 1 el filtro es idéntico al de siempre (sin setpts/F ni atempo)', () => {
		const sin = construirFiltro(tramos, {video: 0, audio: 1});
		expect(construirFiltro(tramos, {video: 0, audio: 1}, null, 1)).toBe(sin);
		expect(sin).not.toContain('atempo');
		expect(sin).toContain('concat=n=3:v=1:a=1[vc][ac]');
	});

	it('con F: un solo atempo (sin cambio de tono), setpts=PTS/F y los cuadros exactos de cada tramo', () => {
		const f = construirFiltro(tramos, {video: 0, audio: 1}, null, 1.2);
		const cortes = cuadrosDeCortes(tramos, 1.2);
		expect(f.match(/atempo=/g)).toHaveLength(1);
		expect(f).not.toMatch(/asetrate|rubberband|adelay/);
		expect(f).toContain(`[acc]atempo=1.2,apad=whole_len=${cortes[3] * 1600},atrim=end_sample=${cortes[3] * 1600}[ac]`);
		expect(f.match(/setpts=PTS\/1\.2/g)).toHaveLength(3);
		tramos.forEach((_, i) => expect(f).toContain(`trim=end_frame=${cortes[i + 1] - cortes[i]}[v${i}]`));
		expect(f).toContain('concat=n=3:v=1:a=0[vc]');
		expect(f).toContain('concat=n=3:v=0:a=1[acc]');
		// Los fundidos de 15 ms siguen dentro de cada tramo, antes de acelerar.
		expect(f).toContain('afade=t=in:ss=0:ns=720');
	});

	it('cuadros = round(Σ/F × 30) y cada corte cae donde lo pone subtitulos.ts (también en un empate de medio cuadro)', () => {
		// Σ del primer tramo = 33 cuadros: 33/1.2 = 27.5 (empate exacto).
		for (const F of [1.2, 1.15, 1.0963, 2, 0.8]) {
			const cortes = cuadrosDeCortes(tramos, F);
			const keep = tramos.map((t) => ({desde: t.inicio / 30, hasta: t.fin / 30}));
			const subs = tramosEnBase(keep, F);
			subs.forEach((s, i) => expect(cortes[i]).toBe(Math.round(s.desde * FPS)));
			expect(cortes.at(-1)).toBe(Math.round(subs.at(-1)!.hasta * FPS));
			expect(cuadrosDeLaBase(tramos, F)).toBe(cortes.at(-1));
			expect(Math.abs(cuadrosDeLaBase(tramos, F) - 75 / F)).toBeLessThanOrEqual(0.5 + 1e-9);
		}
		expect(cuadrosDeLaBase(tramos, 1)).toBe(75);
		expect(cuadrosDeCortes(tramos, 1)).toEqual([0, 33, 48, 75]);
	});

	it('un tramo de un solo cuadro que a F > 1 no llega a un cuadro de la base se queda sin video (su audio sí)', () => {
		const chicos: TramoCuadros[] = [
			{inicio: 0, fin: 10},
			{inicio: 12, fin: 13},
			{inicio: 20, fin: 30},
		];
		const F = 1.5; // 10/1.5 = 6.67 → 7 y 11/1.5 = 7.33 → 7: el tramo de un cuadro no llega a un cuadro de la base
		const cortes = cuadrosDeCortes(chicos, F);
		const vacio = cortes.findIndex((c, i) => i > 0 && c === cortes[i - 1]) - 1;
		expect(vacio).toBe(1);
		const f = construirFiltro(chicos, {video: 0, audio: 1}, null, F);
		expect(f).toContain('setpts=PTS-STARTPTS,nullsink');
		expect(f).toContain('concat=n=2:v=1:a=0[vc]');
		expect(f).toContain('concat=n=3:v=0:a=1[acc]');
	});

	it('tramos_base_s: dónde cae cada tramo en la base acelerada (lo mismo que remapear)', () => {
		const t = tramosEnLaBase(tramos, 1.15);
		expect(t[0][0]).toBe(0);
		expect(t[1][0]).toBeCloseTo(33 / 30 / 1.15, 6);
		expect(t[2][1]).toBeCloseTo(75 / 30 / 1.15, 6);
	});
});

// ───────────────────────── base.ts de punta a punta (ffmpeg real) ─────────────────────────

/** Clip de 4 s (360×640, 30 fps) cuyo cuadro k tiene luma 16 + 4·(k mod 50); audio a 48 kHz. */
function generarClip(ruta: string, audio: string): void {
	const r = spawnSync(
		'ffmpeg',
		[
			'-nostdin', '-v', 'error', '-y',
			'-f', 'lavfi', '-i', "nullsrc=s=360x640:r=30:d=4,format=yuv420p,geq=lum='16+4*mod(N\\,50)':cb=128:cr=128",
			'-f', 'lavfi', '-i', audio,
			'-c:v', 'libx264', '-crf', '1', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-ac', '1', '-shortest', ruta,
		],
		{encoding: 'utf8'},
	);
	if (r.status !== 0) throw new Error(r.stderr);
}

/** Luma media de cada cuadro de un video (signalstats). */
function lumas(video: string): number[] {
	const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', video, '-vf', "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file='pipe\\:1'", '-f', 'null', '-'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
	return [...r.stdout.matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
}

/** Audio mono a 48 kHz en float. */
function audio48k(archivo: string, filtro?: string): Float32Array {
	const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', archivo, '-map', '0:a:0', ...(filtro ? ['-af', filtro] : []), '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {maxBuffer: 256 * 1024 * 1024});
	const b = r.stdout as Buffer;
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

/** Cuadro del crudo que muestra cada cuadro de la base (desenvuelve el módulo 50; los cuadros solo avanzan). */
function cuadrosDelCrudo(ys: number[]): number[] {
	const salida: number[] = [];
	let vuelta = 0;
	for (const y of ys) {
		let k = Math.round((y - 16) / 4) + 50 * vuelta;
		if (salida.length > 0 && k < salida.at(-1)! - 10) {
			vuelta++;
			k += 50;
		}
		salida.push(k);
	}
	return salida;
}

/** Frecuencia fundamental (Hz) por autocorrelación de un tramo de señal (para tonos puros). */
function f0Tono(x: Float32Array, fs: number, desde: number, hasta: number): number {
	const s = x.subarray(Math.round(desde * fs), Math.round(hasta * fs));
	let mejor = 0;
	let mejorLag = 0;
	const corr = (lag: number) => {
		let a = 0;
		for (let i = 0; i + lag < s.length; i++) a += s[i] * s[i + lag];
		return a;
	};
	for (let lag = Math.floor(fs / 1000); lag <= Math.ceil(fs / 200); lag++) {
		const c = corr(lag);
		if (c > mejor) {
			mejor = c;
			mejorLag = lag;
		}
	}
	const [a, b, c] = [corr(mejorLag - 1), corr(mejorLag), corr(mejorLag + 1)];
	const ajuste = (a - c) / (2 * (a - 2 * b + c));
	return fs / (mejorLag + ajuste);
}

/** Arranques de pitidos: primera muestra con |x| > umbral después de al menos 10 ms de silencio. */
function arranques(x: Float32Array, fs: number, umbral = 0.05): number[] {
	const salida: number[] = [];
	let quieto = Number.POSITIVE_INFINITY;
	for (let i = 0; i < x.length; i++) {
		if (Math.abs(x[i]) > umbral) {
			if (quieto >= fs * 0.01) salida.push(i / fs);
			quieto = 0;
		} else quieto++;
	}
	return salida;
}

describe('base.ts de punta a punta con velocidad (ffmpeg real, clip sintético)', () => {
	const proyectos = join(tmp, 'e2e');
	const tono = join(tmp, 'tono.mp4');
	const pitidos = join(tmp, 'pitidos.mp4');
	generarClip(tono, 'sine=frequency=440:sample_rate=48000:duration=4');
	// Pitidos de 30 ms en 0.125 + 0.25·k s (ninguno pegado al borde de un tramo, donde está el fundido), sobre un piso de
	// ruido a −50 dBFS como el de una grabación real: sobre silencio DIGITAL, WSOLA adelanta ~18 ms los arranques (eso
	// nunca pasa con tu voz, medido en pruebas/integracion/f6-velocidad.ts).
	generarClip(pitidos, "aevalsrc=exprs='if(lt(mod(t-0.125,0.25),0.03),0.5*sin(2*PI*1000*t),0)+0.003*(2*random(0)-1)':s=48000:d=4");
	const keep = [
		{desde: 0.5, hasta: 1.6},
		{desde: 2.0, hasta: 2.5},
		{desde: 2.6, hasta: 3.5},
	];
	const crudoDe = (slug: string) => (slug.startsWith('_tono') ? tono : pitidos);
	const preparar = async (slug: string, cortes: object | null) => {
		await ingerir({ruta: crudoDe(slug), slug, proyectos});
		if (!cortes) return undefined;
		const ruta = join(proyectos, slug, 'cortes.json');
		writeFileSync(ruta, JSON.stringify(cortes));
		return ruta;
	};

	it.each([1.25, 1.2, 1.15])('F = %s: cuadros, audio = video, cortes donde los espera subtitulos.ts y contenido de cada cuadro', async (F) => {
		const slug = `_tono-${String(F).replace('.', '-')}`;
		const cortes = await preparar(slug, {keep, velocidad: F});
		const r = await generarBase({slug, cortes, proyectos});
		const N = 75; // cuadros del crudo: 33 + 15 + 27
		const M = Math.round(duracionBase(keep, F) * 30);
		expect(Math.abs(M - N / F)).toBeLessThanOrEqual(0.5 + 1e-9); // con F = 1.2 el primer tramo da 27.5: empate
		expect(r.velocidad).toEqual({factor: F, origen: 'cortes.json'});
		expect(r.verificacion).toMatchObject({ok: true, cuadros: M, cuadros_esperados: M, r_frame_rate: '30/1'});
		expect(r.verificacion!.dif_cuadros_audio_video!).toBeLessThanOrEqual(1);

		const crudo = cuadrosDelCrudo(lumas(r.salida));
		expect(crudo).toHaveLength(M);
		// Cada corte en el cuadro que calcula subtitulos.ts (tramosEnBase con la velocidad de cortes.json).
		const subs = tramosEnBase(keep, F);
		keep.forEach((t, i) => {
			const primero = crudo.findIndex((c) => c >= Math.round(t.desde * 30));
			expect(primero, `tramo ${i}`).toBe(Math.round(subs[i].desde * 30));
		});
		// Cada cuadro muestra un cuadro de su tramo, a menos de un cuadro (×F) de donde cae en el tiempo.
		crudo.forEach((c, m) => {
			const i = subs.findIndex((s) => m >= Math.round(s.desde * 30) && m < Math.round(s.hasta * 30));
			expect(i, `cuadro ${m}`).toBeGreaterThanOrEqual(0);
			const ideal = keep[i].desde * 30 + (m / 30 - subs[i].desde) * 30 * F;
			expect(c).toBeGreaterThanOrEqual(Math.round(keep[i].desde * 30));
			expect(c).toBeLessThan(Math.round(keep[i].hasta * 30));
			expect(Math.abs(c - ideal), `cuadro ${m}: muestra ${c}, ideal ${ideal.toFixed(2)}`).toBeLessThanOrEqual(F + 0.5);
		});

		const etapa = leerManifest(slug, proyectos)!.etapas.base;
		expect(etapa.parametros.velocidad).toBe(F);
		expect(etapa.parametros.tramos_cuadros).toEqual([
			[15, 48],
			[60, 75],
			[78, 105],
		]); // en cuadros del CRUDO
		expect((etapa as {tramos_base_s?: number[][]}).tramos_base_s?.[1][0]).toBeCloseTo(subs[1].desde, 6);
	}, 60_000);

	it('el tono no cambia (440 Hz ±2 %); el control con asetrate sí lo sube ×F', async () => {
		const F = 1.25;
		const slug = '_tono-tono';
		const cortes = await preparar(slug, {keep, velocidad: F});
		const r = await generarBase({slug, cortes, proyectos});
		const x = audio48k(r.salida);
		const f0 = f0Tono(x, 48000, 0.2, 0.8); // dentro del primer tramo, lejos de los fundidos
		expect(Math.abs(f0 / 440 - 1)).toBeLessThanOrEqual(0.02);
		const control = audio48k(tono, `atrim=0.5:1.6,asetrate=${48000 * F},aresample=48000`);
		expect(f0Tono(control, 48000, 0.1, 0.6) / 440).toBeGreaterThan(1 + 0.8 * (F - 1));
	}, 60_000);

	it('el audio queda donde dice el remapeo: cada pitido a ±15 ms de remapear(keep, t, F) y la mediana a ±8 ms', async () => {
		for (const F of [1.15, 1.0963]) {
			const slug = `_pitidos-${String(F).replace('.', '-')}`;
			const cortes = await preparar(slug, {keep, velocidad: F});
			const r = await generarBase({slug, cortes, proyectos});
			const medidos = arranques(audio48k(r.salida), 48000);
			const crudos = Array.from({length: 16}, (_, k) => 0.125 + 0.25 * k).filter((t) => keep.some((tr) => t >= tr.desde && t + 0.03 <= tr.hasta));
			const esperados = crudos.map((t) => remapear(keep, t, F)!);
			expect(esperados.length).toBe(10);
			expect(medidos).toHaveLength(esperados.length);
			const errores = medidos.map((t, k) => (t - esperados[k]) * 1000);
			errores.forEach((e, k) => expect(Math.abs(e), `pitido ${k} (F ${F}): ${e.toFixed(1)} ms`).toBeLessThanOrEqual(15));
			const orden = [...errores].sort((a, b) => a - b);
			expect(Math.abs((orden[4] + orden[5]) / 2), `mediana (F ${F})`).toBeLessThanOrEqual(8);
		}
	}, 60_000);

	it('vigencia: la misma F se reutiliza; otra F la rehace; ×1 deja los parámetros de siempre', async () => {
		const slug = '_tono-vigencia';
		const cortes = (await preparar(slug, {keep, velocidad: 1.15}))!;
		expect((await generarBase({slug, cortes, proyectos})).reutilizada).toBe(false);
		expect((await generarBase({slug, cortes, proyectos})).reutilizada).toBe(true);
		writeFileSync(cortes, JSON.stringify({keep, velocidad: 1.1}));
		const otra = await generarBase({slug, cortes, proyectos});
		expect(otra.reutilizada).toBe(false);
		expect(otra.verificacion?.cuadros).toBe(Math.round(75 / 1.1));
		writeFileSync(cortes, JSON.stringify({keep, velocidad: 1}));
		const x1 = await generarBase({slug, cortes, proyectos});
		expect(x1.verificacion?.cuadros).toBe(75);
		const parametros = leerManifest(slug, proyectos)!.etapas.base.parametros;
		expect(Object.keys(parametros).sort()).toEqual(['audio', 'fade_ms', 'fps', 'lienzo', 'tramos_cuadros', 'version', 'video']);
	}, 60_000);

	it('pedir otra velocidad que la de cortes.json sale con código 2 sin escribir nada; sin cortes.json, --velocidad acelera la ventana', async () => {
		const slug = '_tono-choque';
		const cortes = (await preparar(slug, {keep, velocidad: 1.15}))!;
		const e = await falloAsync(generarBase({slug, cortes, proyectos, velocidad: 1.2}));
		expect(e.codigo).toBe(2);
		expect(e.message).toMatch(FORMATO);
		expect(leerManifest(slug, proyectos)!.etapas.base).toBeUndefined();
		const ventana = await generarBase({slug, desde: 1, hasta: 2, velocidad: 1.25, proyectos});
		expect(ventana.verificacion?.cuadros).toBe(24); // 30 cuadros / 1.25
		expect(ventana.velocidad).toEqual({factor: 1.25, origen: '--velocidad'});
		// Sin cortes ni --velocidad: el clip tal cual.
		expect((await generarBase({slug, desde: 1, hasta: 2, proyectos})).verificacion?.cuadros).toBe(30);
	}, 60_000);
});

// ───────────────────────── cortes.ts ─────────────────────────

describe('cortes.ts: velocidad por defecto de tu calibración', () => {
	const archivo = join(tmp, 'estilo', 'calibracion-cortes.json');
	const cal = (velocidad: unknown) => ({archivo, velocidad: velocidad as never});

	it('usa la mediana medida si está marcada consistente; si no, ×1 (y dice por qué)', () => {
		const v = resolverVelocidadCortes(undefined, cal({mediana: 1.0963, consistente: true, n_pares: 4, n_tramos: 37, min: 1.05, max: 1.15}));
		expect(v.factor).toBe(1.0963);
		expect(v.fuente).toContain('n = 37 tramos de habla en 4 pares');
		expect(resolverVelocidadCortes(undefined, cal({mediana: 1.0963, consistente: false})).factor).toBe(1);
		expect(resolverVelocidadCortes(undefined, cal({mediana: null, consistente: true})).factor).toBe(1);
		expect(resolverVelocidadCortes(undefined, cal({mediana: 3, consistente: true})).factor).toBe(1);
		expect(resolverVelocidadCortes(undefined, cal(null)).fuente).toContain('no trae la velocidad');
		expect(resolverVelocidadCortes(undefined, null).factor).toBe(1);
	});

	it('tu velocidad fija (estilo/velocidad.json) manda sobre la mediana; --velocidad manda sobre ella', () => {
		const c = cal({mediana: 1.0963, consistente: true});
		const pref = {archivo: join(tmp, 'estilo', 'velocidad.json'), factor: 1.14, decision: 'el creador: 1.14x'};
		const v = resolverVelocidadCortes(undefined, c, pref);
		expect(v.factor).toBe(1.14);
		expect(v.fuente).toContain('el creador: 1.14x');
		expect(resolverVelocidadCortes(undefined, null, pref).factor).toBe(1.14);
		expect(resolverVelocidadCortes(1, c, pref).factor).toBe(1);
	});

	it('leerVelocidadPreferida: null si no existe; código 2 si está mal o fuera de rango', () => {
		mkdirSync(join(tmp, 'estilo'), {recursive: true});
		expect(leerVelocidadPreferida(join(tmp, 'estilo', 'no-existe.json'))).toBeNull();
		const ruta = join(tmp, 'estilo', 'velocidad-prueba.json');
		writeFileSync(ruta, JSON.stringify({factor: 1.14, decision: 'el creador'}));
		expect(leerVelocidadPreferida(ruta)?.factor).toBe(1.14);
		for (const malo of ['{', JSON.stringify({factor: 3, decision: 'x'}), JSON.stringify({factor: 1.1})]) {
			writeFileSync(ruta, malo);
			expect(falloDe(() => leerVelocidadPreferida(ruta)).codigo).toBe(2);
		}
	});

	it('--velocidad manda (y --velocidad 1 la apaga); fuera de 0.5–2 sale con código 2', () => {
		const c = cal({mediana: 1.0963, consistente: true});
		expect(resolverVelocidadCortes(1.15, c).factor).toBe(1.15);
		expect(resolverVelocidadCortes(1, c).factor).toBe(1);
		expect(falloDe(() => resolverVelocidadCortes(2.5, c)).codigo).toBe(2);
		expect(velocidadDeTexto('1.15')).toBe(1.15);
		for (const malo of ['', 'x', '0.2', '2.01']) expect(falloDe(() => velocidadDeTexto(malo)).codigo).toBe(2);
	});

	it('leerCalibracionCortes trae la sección velocidad (y no se cae si no tiene la forma esperada)', () => {
		mkdirSync(join(tmp, 'estilo'), {recursive: true});
		writeFileSync(archivo, JSON.stringify({version: 1, parametros: {padAntesS: 0.04}, velocidad: {mediana: 1.0963, consistente: true, n_pares: 4, n_tramos: 37}}));
		expect(leerCalibracionCortes(archivo)!.velocidad).toMatchObject({mediana: 1.0963, consistente: true});
		writeFileSync(archivo, JSON.stringify({version: 1, parametros: {}, velocidad: {mediana: 'rápido'}}));
		expect(leerCalibracionCortes(archivo)!.velocidad).toBeNull();
		writeFileSync(archivo, JSON.stringify({version: 1, parametros: {}}));
		expect(leerCalibracionCortes(archivo)!.velocidad).toBeNull();
	});

	it('el archivo real estilo/calibracion-cortes.json da la mediana de tus 4 pares', () => {
		const real = leerCalibracionCortes();
		if (!real) return; // sin calibración en esta máquina no hay nada que revisar
		const v = resolverVelocidadCortes(undefined, real);
		if (real.velocidad?.consistente) expect(v.factor).toBe(real.velocidad.mediana);
		else expect(v.factor).toBe(1);
	});
});

describe('cortes.ts: transcripcion-base.json en la base acelerada', () => {
	const FS = 16000;
	const raiz = join(tmp, 'cortes');
	const proyectos = join(raiz, 'proyectos');
	const vocabulario = join(raiz, 'vocabulario.json');
	mkdirSync(proyectos, {recursive: true});
	writeFileSync(vocabulario, JSON.stringify({terminos: [], correcciones: {}}));

	/** Audio sintético: "palabras" (armónicos de 120 Hz) donde se indica, sobre ruido a −65 dBFS. */
	function escena(slug: string): Palabra[] {
		const frases = [
			['uno', 'dos', 'tres'],
			['cuatro', 'cinco', 'seis'],
			['siete', 'ocho'],
		];
		const reales: Array<{t: string; d: number; h: number}> = [];
		let t = 0.6;
		for (const f of frases) {
			for (const w of f) {
				reales.push({t: w, d: t, h: t + 0.3});
				t += 0.38;
			}
			t += 0.9;
		}
		const duracion = t + 0.4;
		const x = new Float64Array(Math.round(duracion * FS));
		const azar = azarConSemilla(5);
		for (let i = 0; i < x.length; i++) x[i] = 10 ** (-65 / 20) * Math.sqrt(3) * (2 * azar() - 1);
		for (const r of reales) {
			for (let i = Math.round(r.d * FS); i < Math.round(r.h * FS); i++) {
				const s = i / FS - r.d;
				const env = Math.min(1, s / 0.005, (r.h - r.d - s) / 0.01);
				let v = 0;
				for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * 120 * k * (i / FS) + k * k * 0.7) / k;
				x[i] += 0.05 * env * v;
			}
		}
		const dir = join(proyectos, slug);
		mkdirSync(dir, {recursive: true});
		escribirWav(join(dir, 'audio16k.wav'), Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768)))), FS);
		const palabras = reales.map((r, i) => ({i, t: r.t, d: Math.round((r.d - 0.02) * 1000) / 1000, h: Math.round((reales[i + 1]?.d ?? r.h + 0.3) * 1000) / 1000}));
		writeFileSync(join(dir, 'transcripcion.json'), JSON.stringify({metodo: 't_dtw', palabras: palabras.map((p) => ({...p, p: 0.9}))}));
		return palabras;
	}

	it('con F: mismos cortes, d y h divididos entre F respecto a su tramo, y la velocidad en cortes.json y en la transcripción', async () => {
		const slug = '_prueba-velocidad';
		escena(slug);
		const x1 = await ejecutarCortes({slug, proyectos, vocabulario, calibracion: false});
		const base1 = JSON.parse(readFileSync(join(proyectos, slug, 'transcripcion-base.json'), 'utf8'));
		expect(x1.velocidad.factor).toBe(1);
		expect(base1.velocidad).toBe(1);
		const F = 1.15;
		const r = await ejecutarCortes({slug, proyectos, vocabulario, calibracion: false, velocidad: F});
		expect(r.keep).toEqual(x1.keep); // la velocidad no cambia qué se corta
		expect(r.keep.length).toBeGreaterThanOrEqual(3);
		expect(r.duracionSinAcelerarS).toBeCloseTo(x1.duracionBaseS, 9);
		expect(r.duracionBaseS).toBeCloseTo(x1.duracionBaseS / F, 9);

		const cortes = JSON.parse(readFileSync(join(proyectos, slug, 'cortes.json'), 'utf8'));
		expect(cortes.velocidad).toBe(F);
		expect(cortes.velocidad_fuente).toBe('--velocidad');
		expect(cortes.duracion_base_s).toBeCloseTo(r.duracionBaseS, 6);
		expect(leerCortesConVelocidad(join(proyectos, slug, 'cortes.json')).velocidad).toBe(F); // base.ts la lee igual

		const base = JSON.parse(readFileSync(join(proyectos, slug, 'transcripcion-base.json'), 'utf8'));
		expect(base.velocidad).toBe(F);
		expect(base.duracion_base_s).toBeCloseTo(x1.duracionBaseS / F, 6);
		const bordes = r.keep.map((_, k) => (k === 0 ? 0 : duracionBase(r.keep.slice(0, k), F)));
		base.palabras.forEach((w: {t: string; d: number; h: number; tramo: number}, j: number) => {
			const w1 = base1.palabras[j];
			expect(w.t).toBe(w1.t);
			expect(w.tramo).toBe(w1.tramo);
			expect(w.d).toBeCloseTo(w1.d / F, 5); // (inicio sin acelerar + (t − desde)) / F = d1 / F
			expect(w.h).toBeCloseTo(w1.h / F, 5);
			expect(w.d).toBeGreaterThanOrEqual(bordes[w.tramo] - 1e-6);
		});
		expect(leerManifest(slug, proyectos)!.etapas.cortes.parametros.velocidad).toBe(F);
		// El texto que apruebas dice la velocidad.
		const md = readFileSync(join(proyectos, slug, 'texto-propuesto.md'), 'utf8');
		expect(md).toContain('a ×1.15');
	});

	it('sin --velocidad usa la calibración consistente que está junto a la carpeta de proyectos', async () => {
		const slug = '_prueba-velocidad-cal';
		escena(slug);
		mkdirSync(join(raiz, 'estilo'), {recursive: true});
		writeFileSync(join(raiz, 'estilo', 'calibracion-cortes.json'), JSON.stringify({version: 1, parametros: {}, velocidad: {mediana: 1.0963, consistente: true, n_pares: 4, n_tramos: 37}}));
		const r = await ejecutarCortes({slug, proyectos, vocabulario});
		expect(r.velocidad.factor).toBe(1.0963);
		expect(JSON.parse(readFileSync(join(proyectos, slug, 'cortes.json'), 'utf8')).velocidad).toBe(1.0963);
		writeFileSync(join(raiz, 'estilo', 'calibracion-cortes.json'), JSON.stringify({version: 1, parametros: {}, velocidad: {mediana: 1.0963, consistente: false}}));
		expect((await ejecutarCortes({slug, proyectos, vocabulario})).velocidad.factor).toBe(1);
		rmSync(join(raiz, 'estilo'), {recursive: true, force: true});
	});

	it('armarTranscripcionBase con F = 1 no cambia nada', () => {
		const keep: Tramo[] = [{desde: 0.5, hasta: 1.5}];
		const palabras: Palabra[] = [{i: 0, t: 'hola', d: 0.6, h: 1.0}];
		const salida = [{t: 'hola', desde: 0, hasta: 0}];
		expect(armarTranscripcionBase(keep, palabras, salida, [0], 1)).toEqual(armarTranscripcionBase(keep, palabras, salida, [0]));
		const [w] = armarTranscripcionBase(keep, palabras, salida, [0], 1.25);
		expect(w.d).toBeCloseTo(0.1 / 1.25, 6);
		expect(w.h).toBeCloseTo(0.5 / 1.25, 6);
	});
});

// ───────────────────────── subtitulos.ts ─────────────────────────

describe('subtitulos.ts con velocidad', () => {
	const proyectos = join(tmp, 'subtitulos');
	const keep = [
		{desde: 1, hasta: 2},
		{desde: 3, hasta: 5},
	];
	const F = 1.25;
	const palabras = [
		{i: 0, t: 'Hola', d: 0.1 / F, h: 0.4 / F, tramo: 0},
		{i: 1, t: 'a', d: 0.45 / F, h: 0.6 / F, tramo: 0},
		{i: 2, t: 'todos.', d: 0.65 / F, h: 0.95 / F, tramo: 0},
		{i: 3, t: 'Esto', d: 1.05 / F, h: 1.4 / F, tramo: 1},
		{i: 4, t: 'va', d: 1.45 / F, h: 1.7 / F, tramo: 1},
		{i: 5, t: 'rápido.', d: 1.75 / F, h: 2.9 / F, tramo: 1},
	];
	const escribir = (slug: string, nombre: string, datos: unknown) => {
		mkdirSync(join(proyectos, slug), {recursive: true});
		writeFileSync(join(proyectos, slug, nombre), JSON.stringify(datos));
	};

	it('tramosEnBase divide los bordes entre F', () => {
		const sin = tramosEnBase(keep);
		const con = tramosEnBase(keep, F);
		con.forEach((t, i) => {
			expect(t.desde).toBeCloseTo(sin[i].desde / F, 12);
			expect(t.hasta).toBeCloseTo(sin[i].hasta / F, 12);
		});
	});

	it.runIf(HAY_FUENTES)('con la velocidad de transcripcion-base.json ningún subtítulo cruza el corte de la base acelerada', async () => {
		const slug = '_prueba-subs-vel';
		escribir(slug, 'transcripcion-base.json', {velocidad: F, palabras});
		escribir(slug, 'cortes.json', {keep, velocidad: F});
		registrarEtapa(slug, 'base', {estado: 'terminada', entradas: [], parametros: {tramos_cuadros: [[30, 60], [90, 150]], velocidad: F}, extra: {verificacion: {duracion_video_s: 3 / F}}}, proyectos);
		const r = await generarSubtitulos({slug, proyectos, estilo: null, adelantoCuadros: 0});
		const corte = Math.round((1 / F) * 30); // cuadro 24
		for (const s of r.subtitulos) {
			const ini = Math.round(s.desde * 30);
			const fin = Math.round(s.hasta * 30);
			expect(ini >= corte || fin <= corte, `${s.id} ${ini}–${fin}`).toBe(true);
		}
		expect(r.subtitulos.at(-1)!.hasta).toBeLessThanOrEqual(3 / F + 1e-9);
		expect(r.origen.keep).toContain('×1.25');
	});

	it('si la base del manifest es de otra velocidad sale con código 2 (los subtítulos se desfasarían)', async () => {
		const slug = '_prueba-subs-choque';
		escribir(slug, 'transcripcion-base.json', {velocidad: F, palabras});
		escribir(slug, 'cortes.json', {keep, velocidad: F});
		registrarEtapa(slug, 'base', {estado: 'terminada', entradas: [], parametros: {tramos_cuadros: [[30, 60], [90, 150]]}}, proyectos);
		const e = await falloAsync(generarSubtitulos({slug, proyectos, estilo: null}));
		expect(e.codigo).toBe(2);
		expect(e.message).toMatch(FORMATO);
		expect(e.message).toContain('base.ts');
	});
});

// ───────────────────────── qa.ts ─────────────────────────

describe('qa.ts: la sincronía usa la velocidad de la base', () => {
	const proyectos = join(tmp, 'qa');
	const slug = '_prueba-qa-vel';

	it('velocidadDeLaBase: sin dato ×1, con dato la del manifest, inválida → código 2', () => {
		registrarEtapa(slug, 'base', {estado: 'terminada', entradas: [], parametros: {tramos_cuadros: [[0, 60], [90, 180]]}}, proyectos);
		expect(velocidadDeLaBase(slug, proyectos)).toBe(1);
		registrarEtapa(slug, 'base', {estado: 'terminada', entradas: [], parametros: {tramos_cuadros: [[0, 60], [90, 180]], velocidad: 3}}, proyectos);
		expect(falloDe(() => velocidadDeLaBase(slug, proyectos)).codigo).toBe(2);
	});

	it('con el audio del crudo, el mapeo divide entre la velocidad de la base', () => {
		registrarEtapa(slug, 'base', {estado: 'terminada', entradas: [], parametros: {tramos_cuadros: [[0, 60], [90, 180]], velocidad: 1.25}}, proyectos);
		writeFileSync(join(proyectos, slug, 'audio16k.wav'), 'no se lee aquí');
		const edicion = {...edicionVacia, base: `p/${slug}/base.mp4`};
		const prep = prepararSincronia({slug, edicion, pedida: 'original', video: join(tmp, 'no-existe.mp4'), dirQa: join(tmp, 'qa-dir'), proyectos});
		expect(prep.fuente).toBe('original');
		expect(prep.mapeo!.aBase(3.2)).toBeCloseTo(2.2 / 1.25, 12);
		expect(prep.nota).toContain('×1.25');
	});
});

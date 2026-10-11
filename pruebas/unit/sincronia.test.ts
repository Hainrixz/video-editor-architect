/**
 * Pruebas de herramientas/lib/sincronia.ts (verdad de consenso de la Fase 1) con datos sintéticos:
 * - parseo de silencedetect y de aspectralstats;
 * - arranque por flujo, consenso a ±25 ms y emparejado con los subtítulos (identidad y crudo → base con un corte);
 * - estadística (p50/p95 de |error|, % en −67…+45 ms, N mínimo);
 * - de punta a punta con ffmpeg real sobre un WAV sintético con arranques conocidos y subtítulos corridos
 *   a propósito: el error medido tiene que dar el corrimiento sembrado.
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {escribirWav} from '../../herramientas/lib/energia.ts';
import {
	arranquePorFlujo,
	arranquesDeConsenso,
	emparejarSubtitulos,
	estadisticaSincronia,
	mapeoDesdeTramos,
	medirSincronia,
	parsearFlujo,
	parsearSilencios,
	percentil,
	SINCRONIA,
	type Arranque,
	type Flujo,
	type SubtituloSinc,
} from '../../herramientas/lib/sincronia.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sincronia-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

/** Flujo sintético cada 2 ms: piso `piso` y `alto` desde cada arranque (s) durante `dura` s. */
function flujoSintetico(duracionS: number, arranques: number[], piso = 1e-6, alto = 1e-2, dura = 0.4): Flujo {
	const n = Math.floor(duracionS / 0.002);
	const t = new Float64Array(n);
	const valor = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		t[i] = i * 0.002;
		valor[i] = arranques.some((a) => t[i] >= a - 1e-9 && t[i] < a + dura) ? alto : piso * (1 + 0.1 * Math.sin(i));
	}
	return {t, valor};
}

const palabra = (i: number, t: string, d: number) => ({i, t, d, h: d + 0.2});
const sub = (id: string, desde: number, palabras: Array<ReturnType<typeof palabra>>): SubtituloSinc => ({id, desde, hasta: palabras[palabras.length - 1].h, palabras});
const arranque = (inicio: number, fin: number, flujoS: number | null): Arranque => ({
	pausa: {inicio, fin},
	silencioMs: fin * 1000,
	flujoMs: flujoS === null ? null : flujoS * 1000,
	consenso: flujoS !== null && Math.abs(fin - flujoS) * 1000 <= SINCRONIA.consensoMs,
});

describe('parseo de ffmpeg', () => {
	it('silencedetect: cada silence_end con su duración da una pausa', () => {
		const stderr = [
			'[silencedetect @ 0x1] silence_start: 0',
			'[silencedetect @ 0x1] silence_end: 1.0045 | silence_duration: 1.0045',
			'[silencedetect @ 0x1] silence_start: 2.1',
			'[silencedetect @ 0x1] silence_end: 2.6 | silence_duration: 0.5',
			'[silencedetect @ 0x1] silence_start: 9.5',
		].join('\n');
		const p = parsearSilencios(stderr);
		expect(p).toHaveLength(2);
		expect(p[0]).toEqual({inicio: 0, fin: 1.0045});
		expect(p[1].inicio).toBeCloseTo(2.1, 9);
		expect(p[1].fin).toBe(2.6);
	});

	it('aspectralstats: une cada pts_time con su flux', () => {
		const stdout = [
			'frame:0    pts:0       pts_time:0',
			'lavfi.aspectralstats.1.flux=0.000001',
			'frame:1    pts:32      pts_time:0.002',
			'lavfi.aspectralstats.1.flux=0.5',
			'frame:2    pts:64      pts_time:0.004',
		].join('\n');
		const f = parsearFlujo(stdout);
		expect(Array.from(f.t)).toEqual([0, 0.002]);
		expect(Array.from(f.valor)).toEqual([0.000001, 0.5]);
	});

	it('percentil con interpolación lineal (como la compuerta de la Fase 0)', () => {
		expect(percentil([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(percentil([0, 10], 0.95)).toBeCloseTo(9.5, 9);
		expect(Number.isNaN(percentil([], 0.5))).toBe(true);
	});
});

describe('verdad de consenso', () => {
	it('el arranque por flujo cae en el primer cuadro sobre la mediana de la pausa + 20 dB', () => {
		const f = flujoSintetico(3, [1.0]);
		expect(arranquePorFlujo(f, {inicio: 0.2, fin: 1.0})).toBe(1000);
	});

	it('no da arranque si la pausa no deja al menos 5 cuadros para su mediana', () => {
		const f = flujoSintetico(3, [1.0]);
		expect(arranquePorFlujo(f, {inicio: 0.9, fin: 1.0})).toBeNull();
	});

	it('el silencio digital (flujo 0) no cuenta como arranque', () => {
		const f = flujoSintetico(3, [1.5], 0);
		expect(arranquePorFlujo(f, {inicio: 0.2, fin: 1.5})).toBe(1500);
	});

	it('consenso solo si silencedetect y el flujo coinciden a ±25 ms; la pausa del final no cuenta', () => {
		const f = flujoSintetico(6, [1.0, 3.04]);
		const pausas = [
			{inicio: 0.2, fin: 1.01}, // flujo 1.000 → 10 ms: consenso
			{inicio: 2.0, fin: 3.0}, // flujo 3.040 → 40 ms: sin consenso
			{inicio: 5.5, fin: 5.98}, // termina con el audio: no la sigue ninguna palabra
		];
		const a = arranquesDeConsenso(pausas, f, 6);
		expect(a).toHaveLength(2);
		expect(a[0]).toMatchObject({silencioMs: 1010, flujoMs: 1000, consenso: true});
		expect(a[1]).toMatchObject({silencioMs: 3000, flujoMs: 3040, consenso: false});
	});
});

describe('emparejado con los subtítulos', () => {
	const subtitulos = [
		sub('s1', 1.01, [palabra(0, 'hola', 1.01), palabra(1, 'a', 1.2)]),
		sub('s2', 1.6, [palabra(2, 'todos', 1.6)]),
		sub('s3', 2.47, [palabra(3, 'esto', 2.48), palabra(4, 'es', 2.7)]),
		sub('s4', 3.5, [palabra(5, 'una', 3.5), palabra(6, 'prueba', 4.2)]),
	];

	it('error = desde del subtítulo − arranque, con signo', () => {
		const {pares, excluidos} = emparejarSubtitulos([arranque(0.2, 1.0, 1.005), arranque(2.0, 2.5, 2.49)], subtitulos);
		expect(pares.map((p) => [p.subtitulo, p.error_ms])).toEqual([
			['s1', 10],
			['s3', -30],
		]);
		expect(pares[1].error_palabra_ms).toBe(-20);
		expect(pares[1].error_cuadro_ms).toBeCloseTo(-33.3, 1); // round(2.47 × 30) = 74 → 2.4667 s
		expect(Object.values(excluidos).reduce((a, b) => a + b, 0)).toBe(0);
	});

	it('excluye el arranque sin consenso y la pausa que cae en medio de un subtítulo', () => {
		// La pausa 3.7–4.2 cae dentro de s4: la primera palabra tras la pausa ("prueba") no abre ningún subtítulo.
		const {pares, excluidos} = emparejarSubtitulos([arranque(0.2, 1.0, 1.06), arranque(3.7, 4.2, 4.2)], subtitulos);
		expect(pares).toHaveLength(0);
		expect(excluidos.sinConsenso).toBe(1);
		expect(excluidos.noEmpieza).toBe(1);
	});

	it('si dos pausas caen en la misma palabra, cuenta la última', () => {
		const {pares, excluidos} = emparejarSubtitulos([arranque(2.0, 2.3, 2.3), arranque(2.35, 2.46, 2.46)], subtitulos);
		expect(pares).toHaveLength(1);
		expect(pares[0]).toMatchObject({subtitulo: 's3', arranque_s: 2.46});
		expect(excluidos.palabraRepetida).toBe(1);
	});

	it('con audio del crudo: pasa el arranque a la base y descarta el que cae en un corte', () => {
		// Base = crudo [0, 2) s + [3, 6) s (cuadros [0, 60) y [90, 180)): el crudo 3.2 s es la base 2.2 s.
		const mapeo = mapeoDesdeTramos([
			[0, 60],
			[90, 180],
		]);
		const subs = [sub('a', 0.5, [palabra(0, 'uno', 0.5)]), sub('b', 2.21, [palabra(1, 'dos', 2.21)])];
		const {pares, excluidos} = emparejarSubtitulos([arranque(0.1, 0.49, 0.49), arranque(2.1, 3.2, 3.19), arranque(2.0, 2.5, 2.5)], subs, mapeo);
		expect(pares.map((p) => [p.subtitulo, p.arranque_s, p.arranque_ref_s, p.error_ms])).toEqual([
			['a', 0.49, 0.49, 10],
			['b', 2.2, 3.2, 10],
		]);
		expect(excluidos.enCorte).toBe(1);
	});
});

describe('estadística y criterio', () => {
	it('p50 y p95 de |error|, mediana con signo y % dentro de −67…+45 ms', () => {
		const errores = [-10, 5, 0, 20, -30, 15, 8, -2, 12, 50];
		const e = estadisticaSincronia(errores);
		expect(e.N).toBe(10);
		expect(e.p50_ms).toBe(11);
		expect(e.p95_ms).toBe(41);
		expect(e.mediana_error_ms).toBe(6.5);
		expect(e.dentro_pct).toBe(90);
		expect(e.pasa).toBe(true);
	});

	it('falla si el p95 pasa de 45 ms', () => {
		expect(estadisticaSincronia([0, 1, 2, 3, 4, 5, 6, 7, 8, 120]).pasa).toBe(false);
	});

	it('con N < 10 queda N/A (null) y lo dice; con N = 0 todo es null', () => {
		const e = estadisticaSincronia([1, 2, 3]);
		expect(e.pasa).toBeNull();
		expect(e.nota).toMatch(/N = 3/);
		const vacio = estadisticaSincronia([]);
		expect(vacio).toMatchObject({N: 0, p50_ms: null, p95_ms: null, pasa: null});
	});
});

describe('de punta a punta con ffmpeg real (WAV sintético)', () => {
	/** Voz sintética (armónicos de 120 Hz) que arranca con 5 ms de rampa, sobre un piso de ruido a −70 dBFS. */
	function wavConArranques(ruta: string, arranques: number[], duracionS: number, largo = 0.6): void {
		const fs = 16000;
		const x = new Int16Array(Math.round(duracionS * fs));
		let semilla = 11;
		const azar = () => {
			semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
			return (semilla / 2 ** 32) * 2 - 1;
		};
		for (let i = 0; i < x.length; i++) {
			let v = 10 ** (-70 / 20) * Math.sqrt(3) * azar();
			const s = i / fs;
			for (const a of arranques) {
				if (s >= a && s < a + largo) {
					const t = s - a;
					let voz = 0;
					for (let k = 1; k <= 25; k++) voz += Math.sin(2 * Math.PI * k * 120 * t + k * k * 0.7) / k;
					v += (0.1 / Math.sqrt(0.8)) * voz * (t < 0.005 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.005) : 1);
				}
			}
			x[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
		}
		escribirWav(ruta, x, fs);
	}

	it('mide el corrimiento sembrado en cada subtítulo (±6 ms) y todos los arranques tienen consenso', () => {
		const ruta = join(tmp, 'arranques.wav');
		const arranques = [1.0, 2.5, 4.0, 5.5];
		const sembrado = [10, -20, 5, 40]; // ms
		wavConArranques(ruta, arranques, 7);
		const subtitulos = arranques.map((a, k) => {
			const desde = a + sembrado[k] / 1000;
			return sub(`s${k + 1}`, desde, [palabra(k, `p${k}`, desde)]);
		});
		const r = medirSincronia({audio16k: ruta, subtitulos, fuente: 'base'});
		expect(r.arranques).toBe(4);
		expect(r.consenso).toBe(4);
		expect(r.N).toBe(4);
		r.pares.forEach((p, k) => {
			expect(p.subtitulo).toBe(`s${k + 1}`);
			expect(Math.abs(p.error_ms - sembrado[k])).toBeLessThanOrEqual(6);
		});
		expect(r.pasa).toBeNull(); // N = 4 < 10
	}, 30_000);
});

// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/lib/onsets.ts, todas puras (sin ffmpeg, sin red): FFT, espectrograma, filtros,
 * cuantiles locales y cada detector sobre audio sintético (ruido con ritmo de habla + SFX conocidos).
 * La validación con tu voz real y los SFX de Pixabay está en pruebas/integracion/f2-onsets.ts.
 */
import {describe, expect, it} from 'vitest';
import {
	aDb,
	candidatosAgudos,
	candidatosClic,
	candidatosGolpe,
	candidatosOnsets,
	candidatosTono,
	cuantilDe,
	cuantilLocal,
	detectarOnsets,
	espectrograma,
	fft,
	fusionar,
	lateralLimpio,
	pasaBanda,
	PARAMETROS_ONSETS,
	potenciaPorBloques,
	recalcularMargenes,
	suprimir,
	type Candidato,
} from '../../herramientas/lib/onsets.ts';

const FS = 44100;

/** PRNG con semilla (mulberry32). */
function azar(semilla: number): () => number {
	let a = semilla >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** "Voz" sintética: ruido rosa aproximado (filtrado) con sílabas de 4 Hz y un tono grave de 120 Hz. */
function vozSintetica(segundos: number, semilla = 1): Float32Array {
	const r = azar(semilla);
	const n = Math.round(segundos * FS);
	const x = new Float32Array(n);
	let b0 = 0;
	let b1 = 0;
	for (let i = 0; i < n; i++) {
		const blanco = r() * 2 - 1;
		b0 = 0.99 * b0 + 0.1 * blanco;
		b1 = 0.6 * b1 + 0.4 * blanco;
		const silaba = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / FS);
		const t = i / FS;
		x[i] = silaba * (0.05 * b0 + 0.01 * b1 + 0.08 * Math.sin(2 * Math.PI * 120 * t));
	}
	return x;
}

/** Suma un clic (impulso de banda ancha que se apaga en ~3 ms) en t. */
function sumarClic(x: Float32Array, t: number, amp: number, semilla = 9): void {
	const r = azar(semilla);
	const i0 = Math.round(t * FS);
	for (let k = 0; k < Math.round(0.004 * FS); k++) x[i0 + k] += amp * (r() * 2 - 1) * Math.exp(-k / (0.0008 * FS));
}

describe('fft y espectrograma', () => {
	it('la FFT coincide con la DFT directa', () => {
		const r = azar(3);
		const n = 64;
		const re = Float64Array.from({length: n}, () => r() * 2 - 1);
		const im = new Float64Array(n);
		const x = Float64Array.from(re);
		fft(re, im);
		for (let k = 0; k < n; k++) {
			let sr = 0;
			let si = 0;
			for (let t = 0; t < n; t++) {
				sr += x[t] * Math.cos((-2 * Math.PI * k * t) / n);
				si += x[t] * Math.sin((-2 * Math.PI * k * t) / n);
			}
			expect(Math.abs(re[k] - sr)).toBeLessThan(1e-9);
			expect(Math.abs(im[k] - si)).toBeLessThan(1e-9);
		}
	});

	it('la FFT rechaza tamaños que no son potencia de 2', () => {
		expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
	});

	it('un seno de 1 kHz y amplitud 0.5 da su pico en el bin correcto con magnitud ≈ 0.5', () => {
		const x = Float32Array.from({length: FS / 2}, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS));
		const e = espectrograma(x, FS, 1024, 256);
		const c = 10;
		let mejor = 0;
		for (let k = 1; k < e.nBins; k++) if (e.mag[c * e.nBins + k] > e.mag[c * e.nBins + mejor]) mejor = k;
		expect(mejor).toBe(Math.round((1000 * 1024) / FS));
		expect(e.mag[c * e.nBins + mejor]).toBeGreaterThan(0.45);
		expect(e.mag[c * e.nBins + mejor]).toBeLessThan(0.55);
	});
});

describe('estadística y filtros', () => {
	it('cuantilDe interpola como R tipo 7', () => {
		expect(cuantilDe([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(cuantilDe([10, 20, 30], 0.9)).toBeCloseTo(28, 9);
		expect(Number.isNaN(cuantilDe([], 0.5))).toBe(true);
	});

	it('cuantilLocal deja fuera el propio evento', () => {
		const s = new Float64Array(200).fill(-60);
		for (let k = 100; k < 120; k++) s[k] = 0; // evento sostenido de 20 muestras
		const sin = cuantilLocal(s, 50, 2, 25, 0.95, 1);
		const con = cuantilLocal(s, 50, 2, 0, 0.95, 1);
		expect(sin[100]).toBe(-60); // sin el evento, el contexto es todo −60
		expect(con[100]).toBe(0); // si el evento entra al contexto, se sube su propia referencia
	});

	it('el pasa-banda de 4–16 kHz atenúa 100 Hz más de 40 dB y deja pasar 8 kHz', () => {
		const tono = (f: number) => Float32Array.from({length: FS / 4}, (_, i) => Math.sin((2 * Math.PI * f * i) / FS));
		const nivel = (y: Float32Array) => aDb(potenciaPorBloques(y.subarray(2000), y.length - 2000)[0]);
		expect(nivel(pasaBanda(tono(100), 4000, 16000, FS)) - nivel(tono(100))).toBeLessThan(-40);
		expect(nivel(pasaBanda(tono(8000), 4000, 16000, FS)) - nivel(tono(8000))).toBeGreaterThan(-3);
	});

	it('suprimir deja el de mayor puntaje dentro de la ventana', () => {
		const lista = [{t: 1, p: 1}, {t: 1.01, p: 5}, {t: 1.5, p: 2}];
		expect(suprimir(lista, 0.05, (c) => c.p).map((c) => c.t)).toEqual([1.01, 1.5]);
	});
});

describe('detectores sobre audio sintético', () => {
	it('clic: encuentra clics a ±5 ms y no confunde una oclusiva sostenida', () => {
		const x = vozSintetica(4);
		for (const t of [1, 2, 3]) sumarClic(x, t, 0.6, Math.round(t * 10));
		// "Oclusiva": ráfaga de ruido de 40 ms que sigue sonando (no se apaga en 4–12 ms).
		const r = azar(77);
		const i0 = Math.round(1.5 * FS);
		for (let k = 0; k < Math.round(0.04 * FS); k++) x[i0 + k] += 0.3 * (r() * 2 - 1);
		const c = candidatosClic(x, FS, PARAMETROS_ONSETS.clic).filter((q) => q.margen >= 0);
		for (const t of [1, 2, 3]) expect(c.some((q) => Math.abs(q.t - t) <= 0.005)).toBe(true);
		expect(c.some((q) => Math.abs(q.t - 1.5) <= 0.03)).toBe(false);
	});

	it('tono: un ping de 6 kHz de 200 ms aparece como tono nuevo', () => {
		const x = vozSintetica(4, 2);
		const i0 = Math.round(2.5 * FS);
		for (let k = 0; k < Math.round(0.2 * FS); k++) {
			const ataque = Math.min(1, k / (0.003 * FS));
			x[i0 + k] += 0.2 * ataque * Math.exp(-k / (0.15 * FS)) * Math.sin((2 * Math.PI * 6000 * k) / FS);
		}
		const c = candidatosTono(x, FS, PARAMETROS_ONSETS.tono).filter((q) => q.margen >= 0);
		expect(c.some((q) => Math.abs(q.t - 2.5) <= 0.03)).toBe(true);
	});

	it('golpe: un impacto de 60 Hz por encima de la voz sale en la banda grave', () => {
		const x = vozSintetica(5, 3);
		const i0 = Math.round(3.5 * FS);
		for (let k = 0; k < Math.round(0.4 * FS); k++) x[i0 + k] += 0.8 * Math.exp(-k / (0.12 * FS)) * Math.sin((2 * Math.PI * 60 * k) / FS);
		const c = candidatosGolpe(x, FS, PARAMETROS_ONSETS.golpe).filter((q) => q.margen >= 0);
		expect(c.some((q) => Math.abs(q.t - 3.5) <= 0.03)).toBe(true);
	});

	it('agudos: un estallido de ruido de 4–16 kHz por encima del p90 local', () => {
		const x = vozSintetica(4, 4);
		const r = azar(5);
		const ruido = Float32Array.from({length: Math.round(0.15 * FS)}, () => r() * 2 - 1);
		const alto = pasaBanda(ruido, 4000, 16000, FS);
		const i0 = Math.round(2 * FS);
		for (let k = 0; k < alto.length; k++) x[i0 + k] += 0.5 * alto[k];
		const c = candidatosAgudos(x, FS, PARAMETROS_ONSETS.agudos).filter((q) => q.margen >= 0);
		expect(c.some((q) => Math.abs(q.t - 2) <= 0.02)).toBe(true);
	});

	it('detectarOnsets junta todo, y la voz sola casi no dispara', () => {
		const soloVoz = vozSintetica(6, 6);
		const enVoz = detectarOnsets(soloVoz, FS).onsets;
		expect(enVoz.length).toBeLessThanOrEqual(1);
		const x = vozSintetica(6, 6);
		for (const t of [1.2, 2.7, 4.4]) sumarClic(x, t, 0.6, Math.round(t * 100));
		const r = detectarOnsets(x, FS);
		for (const t of [1.2, 2.7, 4.4]) expect(r.onsets.some((o) => Math.abs(o.t - t) <= 0.05)).toBe(true);
		expect(r.lateral.usado).toBe(false);
	});

	it('recalcularMargenes reproduce los márgenes con los mismos parámetros', () => {
		const x = vozSintetica(3, 8);
		sumarClic(x, 1.5, 0.5);
		const {candidatos} = candidatosOnsets(x, FS, PARAMETROS_ONSETS);
		const otra = recalcularMargenes(candidatos, PARAMETROS_ONSETS);
		candidatos.forEach((c, i) => expect(otra[i].margen).toBeCloseTo(c.margen, 9));
	});
});

describe('fusión y canal lateral', () => {
	it('fusionar junta a menos de 60 ms, queda el tiempo más temprano y suma fuentes', () => {
		const c: Candidato[] = [
			{t: 1.0, fuente: 'clic', margen: 2, rasgos: {}},
			{t: 1.03, fuente: 'agudos', margen: 5, rasgos: {}},
			{t: 1.5, fuente: 'tono', margen: -1, rasgos: {}},
			{t: 2.0, fuente: 'golpe', margen: 0, rasgos: {}},
		];
		const o = fusionar(c, 0.06);
		expect(o).toEqual([
			{t: 1, fuentes: ['clic', 'agudos'], margen_db: 5},
			{t: 2, fuentes: ['golpe'], margen_db: 0},
		]);
	});

	it('lateralLimpio: limpio si la voz va al centro, no si el lateral trae voz', () => {
		const voz = vozSintetica(3, 10);
		expect(lateralLimpio(voz, new Float32Array(voz.length), FS, 60).limpio).toBe(true);
		expect(lateralLimpio(voz, Float32Array.from(voz, (v) => 0.5 * v), FS, 60).limpio).toBe(false);
	});
});

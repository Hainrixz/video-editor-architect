// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/estilo/calibrar-cortes.ts (calibración de los cortes con tus pares crudo ↔ publicado) y de
 * la lectura de estilo/calibracion-cortes.json en herramientas/cortes.ts.
 *
 * El par es sintético y determinista: un "crudo" con palabras que suenan donde se dice (ruido con semilla fija +
 * vocales con sílabas), una toma repetida y pausas; el "publicado" se arma quitando tramos conocidos y acelerándolo
 * ×1.1 (remuestreo). Así cada prueba sabe la verdad: la velocidad, los cortes, lo que se quitó y los bordes.
 * No usa ffmpeg, red ni tus archivos: corre dentro del sandbox.
 */
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {
	analizarEnergia,
	aplicarCalibracion,
	construirKeep,
	ejecutarCortes,
	leerCalibracionCortes,
	PARAMETROS_CORTES,
	refinarPalabras,
	rutaCalibracionCortes,
	verificarCortes,
	type Palabra,
} from '../../herramientas/cortes.ts';
import {
	alinearSecuencias,
	bordesDe,
	buscarParametros,
	buscarSalto,
	buscarTomas,
	clasificarQuitadas,
	correlacion,
	cortesPorMinuto,
	cuantil,
	elegirMejor,
	evaluarCombinacion,
	f1Bordes,
	medianaPonderada,
	medirVelocidadTramo,
	prepararLado,
	reconstruirEdicion,
	resumirVelocidad,
	seleccionPropuesta,
	simularCortes,
	slugsDelPar,
	svgLineaDeTiempo,
	tramosSinPalabras,
	svgMiniaturas,
	tomasDistintas,
	umbralDePausas,
	type DatosPar,
	type EdicionSuya,
	type Envolvente,
	type Lado,
} from '../../herramientas/estilo/calibrar-cortes.ts';
import {escribirWav, type Wav} from '../../herramientas/lib/energia.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {leerManifest} from '../../herramientas/lib/manifest.ts';
import {esSlugValido} from '../../herramientas/lib/slug.ts';
import {OPCIONES_TOMAS} from '../../herramientas/lib/tomas.ts';

// ───────────────────────── audio sintético ─────────────────────────

const FS = 16000;

function lcg(semilla: number): () => number {
	let s = semilla >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}

const amp = (db: number) => 10 ** (db / 20);

/** Palabra que suena de verdad: [d, h) en s, con su nivel, tono y número de sílabas. */
type Real = {t: string; d: number; h: number; nivel: number; f0: number; silabas: number};

/** Ruido de fondo + una "vocal" con sílabas (subidas y bajadas de volumen) por palabra. */
function sintetizar(reales: readonly Real[], duracionS: number, semilla = 11): Float64Array {
	const x = new Float64Array(Math.round(duracionS * FS));
	const azar = lcg(semilla);
	const piso = amp(-62) * Math.sqrt(3);
	for (let i = 0; i < x.length; i++) x[i] = piso * azar();
	for (const r of reales) {
		const i0 = Math.round(r.d * FS);
		const largo = Math.round((r.h - r.d) * FS);
		const escala = amp(r.nivel);
		for (let i = 0; i < largo && i0 + i < x.length; i++) {
			const t = i / FS;
			const fase = (t / (r.h - r.d)) * r.silabas;
			const silaba = 0.35 + 0.65 * Math.sin(Math.PI * (fase % 1)) ** 2;
			const borde = Math.min(1, t / 0.008, (r.h - r.d - t) / 0.012);
			let v = 0;
			for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * k * r.f0 * t + k) / k;
			x[i0 + i] += escala * 0.5 * v * silaba * Math.max(0, borde);
		}
	}
	return x;
}

const aWav = (x: Float64Array): Wav => {
	const muestras = Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
	return {frecuencia: FS, muestras, duracionS: muestras.length / FS};
};

/** Palabras "de whisper": arrancan 10 ms antes y el final se estira hasta la siguiente (como whisper.cpp). */
function comoWhisper(reales: ReadonlyArray<{t: string; d: number; h: number}>, duracionS: number): Palabra[] {
	return reales.map((r, i) => {
		const siguiente = reales[i + 1];
		const d = Math.max(0, r.d - 0.01, i > 0 ? reales[i - 1].h : 0);
		const h = siguiente ? Math.max(r.h, siguiente.d - 0.02) : Math.min(duracionS, r.h + 0.25);
		return {i, t: r.t, d: Math.round(d * 1000) / 1000, h: Math.round(h * 1000) / 1000};
	});
}

/** Frases del crudo con sus pausas: [texto de la frase, pausa después (s)]. Las palabras de una frase van a 0.05 s. */
function armarCrudo(frases: ReadonlyArray<[string, number]>, inicio = 0.4): Real[] {
	const reales: Real[] = [];
	let t = inicio;
	let k = 0;
	for (const [frase, pausa] of frases) {
		const palabras = frase.split(' ');
		palabras.forEach((w, q) => {
			const dur = 0.22 + 0.04 * (w.length % 5) + 0.03 * (k % 3);
			reales.push({t: w, d: Math.round(t * 1000) / 1000, h: Math.round((t + dur) * 1000) / 1000, nivel: -20 - 5 * ((k * 7) % 3), f0: 105 + 13 * (k % 7), silabas: 1 + (w.length % 3)});
			t += dur + (q === palabras.length - 1 ? pausa : 0.05);
			k++;
		});
	}
	return reales;
}

/** Arma el publicado: concatena los tramos que se quedan y lo acelera ×factor (remuestreo lineal). */
function armarPublicado(crudo: Float64Array, keep: ReadonlyArray<{desde: number; hasta: number}>, factor: number): Float64Array {
	const partes: number[] = [];
	for (const t of keep) for (let i = Math.round(t.desde * FS); i < Math.round(t.hasta * FS); i++) partes.push(crudo[i]);
	const n = Math.floor(partes.length / factor);
	const y = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const x = i * factor;
		const k = Math.floor(x);
		const f = x - k;
		y[i] = partes[k] * (1 - f) + (partes[k + 1] ?? partes[k]) * f;
	}
	return y;
}

/** Tiempo del publicado de un tiempo del crudo (dentro de un tramo que se queda). */
function aPublicado(keep: ReadonlyArray<{desde: number; hasta: number}>, t: number, factor: number): number | null {
	let acumulado = 0;
	for (const k of keep) {
		if (t >= k.desde && t <= k.hasta) return (acumulado + (t - k.desde)) / factor;
		acumulado += k.hasta - k.desde;
	}
	return null;
}

// ───────────────────────── el par sintético ─────────────────────────

const FACTOR = 1.1;
const FRASES: Array<[string, number]> = [
	['uno dos tres cuatro cinco seis siete', 0.2],
	['ocho nueve diez once', 1.0],
	['vas a hacer un', 0.8], // toma 1: la quitas
	['vas a hacer un folder nuevo', 0.9], // toma 2: se queda
	['luego corres esto ahora mismo', 0.5],
];
const REALES = armarCrudo(FRASES);
const DURACION_CRUDO = Math.round((REALES.at(-1)!.h + 0.5) * 1000) / 1000;
const iDe = (texto: string, desde = 0) => REALES.findIndex((r, k) => k >= desde && r.t === texto);
const fB = iDe('once');
const iC = iDe('vas');
const iD = iDe('vas', iC + 1);
const fD = iDe('nuevo');
const iE = iDe('luego');
const PAD = 0.04;
/** Tu edición: arranca 0.3 s antes de la primera palabra, quita [once+pad, toma 2−pad] y [nuevo+pad, luego−pad]. */
const KEEP_SUYO = [
	{desde: REALES[0].d - 0.3, hasta: REALES[fB].h + PAD},
	{desde: REALES[iD].d - PAD, hasta: REALES[fD].h + PAD},
	{desde: REALES[iE].d - PAD, hasta: REALES.at(-1)!.h + 0.3},
];
const SELECCION_SUYA = REALES.map((r) => KEEP_SUYO.some((k) => r.d >= k.desde && r.h <= k.hasta));

const SENAL_CRUDO = sintetizar(REALES, DURACION_CRUDO);
const SENAL_PUB = armarPublicado(SENAL_CRUDO, KEEP_SUYO, FACTOR);
const WAV_CRUDO = aWav(SENAL_CRUDO);
const WAV_PUB = aWav(SENAL_PUB);
const DURACION_PUB = WAV_PUB.duracionS;
const REALES_PUB = REALES.flatMap((r, k) => {
	if (!SELECCION_SUYA[k]) return [];
	const d = aPublicado(KEEP_SUYO, r.d, FACTOR);
	const h = aPublicado(KEEP_SUYO, r.h, FACTOR);
	return d === null || h === null ? [] : [{t: r.t, d, h}];
});
/** Cortes en el publicado (s) y sus saltos de imagen (cuadro = primer cuadro después del corte). */
const CORTES_PUB = [1, 2].map((k) => KEEP_SUYO.slice(0, k).reduce((s, t) => s + t.hasta - t.desde, 0) / FACTOR);
function difsSinteticas(): Float64Array {
	const n = Math.ceil(DURACION_PUB * 30) + 1;
	const azar = lcg(5);
	const difs = Float64Array.from({length: n}, () => 3 + azar());
	for (const t of CORTES_PUB) difs[Math.round(t * 30)] = 24;
	difs[0] = 0;
	return difs;
}

const CRUDO: Lado = prepararLado('_cal-sintetico', comoWhisper(REALES, DURACION_CRUDO), WAV_CRUDO, DURACION_CRUDO);
const PUBLICADO: Lado = prepararLado('_cal-pub-sintetico', comoWhisper(REALES_PUB, DURACION_PUB), WAV_PUB, DURACION_PUB);
const SUYA: EdicionSuya = reconstruirEdicion({crudo: CRUDO, publicado: PUBLICADO, difs: difsSinteticas(), fps: 30, duracionPublicadoS: DURACION_PUB});

// ───────────────────────── utilidades ─────────────────────────

describe('calibrar-cortes: utilidades numéricas', () => {
	it('cuantil interpola entre rangos y mediana ponderada respeta los pesos', () => {
		expect(cuantil([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(cuantil([], 0.5)).toBeNull();
		expect(medianaPonderada([{valor: 1, peso: 1}, {valor: 2, peso: 1}, {valor: 10, peso: 5}])).toBe(10);
		expect(medianaPonderada([{valor: 1.05, peso: 3}, {valor: 1.1, peso: 1}])).toBe(1.05);
		expect(medianaPonderada([])).toBeNull();
	});

	it('correlación de Pearson: 1, −1 y NaN con una serie constante', () => {
		expect(correlacion([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
		expect(correlacion([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
		expect(Number.isNaN(correlacion([1, 1, 1], [1, 2, 3]))).toBe(true);
	});

	it('cortes por minuto cuenta los cortes interiores (tramos − 1)', () => {
		expect(cortesPorMinuto(1, 60)).toBe(0);
		expect(cortesPorMinuto(4, 30)).toBe(6);
		expect(cortesPorMinuto(3, 0)).toBe(0);
	});

	it('slugs de los proyectos de calibración: válidos y en minúsculas', () => {
		const s = slugsDelPar('/home/x/Downloads/IMG_5199.MOV', 'Dk5Z144VKLf');
		expect(s).toEqual({crudo: '_cal-img-5199', publicado: '_cal-pub-dk5z144vklf'});
		expect(esSlugValido(s.crudo) && esSlugValido(s.publicado)).toBe(true);
		expect(esSlugValido(slugsDelPar('/a/IMG_5057.MOV', 'Dke4ldZVMC_').publicado)).toBe(true);
	});
});

describe('calibrar-cortes: alineación de palabras', () => {
	it('secuencias iguales se emparejan una a una', () => {
		expect(alinearSecuencias(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([[0, 0], [1, 1], [2, 2]]);
	});

	it('con una toma repetida, el publicado se empareja con la toma que sigue de corrido (la última)', () => {
		const crudo = 'hola vas a hacer un vas a hacer un folder nuevo'.split(' ');
		const pub = 'hola vas a hacer un folder nuevo'.split(' ');
		expect(alinearSecuencias(crudo, pub)).toEqual([[0, 0], [5, 1], [6, 2], [7, 3], [8, 4], [9, 5], [10, 6]]);
	});

	it('un aparte quitado del crudo es un solo hueco y una palabra que solo está en el publicado se salta', () => {
		expect(alinearSecuencias('a b c q r s d e f'.split(' '), 'a b c d e f'.split(' '))).toEqual([[0, 0], [1, 1], [2, 2], [6, 3], [7, 4], [8, 5]]);
		expect(alinearSecuencias('a b c d'.split(' '), 'a b x c d'.split(' '))).toEqual([[0, 0], [1, 1], [2, 3], [3, 4]]);
	});

	it('las claves vacías nunca empatan', () => {
		expect(alinearSecuencias(['', 'a'], ['', 'a'])).toEqual([[1, 1]]);
	});
});

describe('calibrar-cortes: bordes, pausas y saltos de imagen', () => {
	it('F1 de bordes a ±100 ms: uno a uno, los más cercanos primero', () => {
		const r = f1Bordes([1.0, 2.0, 5.0], [1.05, 2.2, 5.09, 9]);
		expect(r.emparejados).toBe(2);
		expect(r.precision).toBeCloseTo(2 / 3, 3);
		expect(r.exhaustividad).toBe(0.5);
		expect(r.f1).toBeCloseTo(0.571, 3);
		expect(f1Bordes([1.0, 1.02], [1.01]).emparejados).toBe(1);
		expect(f1Bordes([], []).f1).toBe(1);
		expect(f1Bordes([1], []).f1).toBe(0);
	});

	it('el umbral de pausas separa las que cortaste de las que dejaste', () => {
		const pausas = [0.2, 0.3, 0.35].map((d) => ({duracion_s: d, cortada: false})).concat([0.5, 0.7, 2].map((d) => ({duracion_s: d, cortada: true})));
		const u = umbralDePausas(pausas);
		expect(u.umbral_s).toBeCloseTo(0.425, 3);
		expect(u.exactitud).toBe(1);
		expect(u.n).toBe(6);
		expect(u.cortadas).toBe(3);
		expect(umbralDePausas([]).umbral_s).toBeNull();
	});

	it('un salto de imagen es un cuadro aislado muy por encima de sus vecinos; un gesto (subida suave) no', () => {
		const difs = Float64Array.from({length: 100}, (_, k) => 3 + (k % 2) * 0.5);
		difs[50] = 20;
		expect(buscarSalto(difs, 45, 55)?.cuadro).toBe(50);
		expect(buscarSalto(difs, 52, 60)).toBeNull();
		const gesto = Float64Array.from({length: 100}, () => 3);
		[8, 12, 14, 12, 8].forEach((v, k) => (gesto[48 + k] = v));
		expect(buscarSalto(gesto, 40, 60)).toBeNull();
	});
});

describe('calibrar-cortes: velocidad', () => {
	it('recupera el factor de una envolvente acelerada ×1.1 y su desfase', () => {
		const salto = 0.005;
		const patron = (t: number) => -40 + 25 * Math.max(0, Math.sin(2.3 * t) * Math.sin(5.1 * t + 1)) + 6 * Math.sin(11.7 * t);
		const crudo: Envolvente = {db: Float64Array.from({length: 2400}, (_, k) => patron(k * salto + 0.005)), saltoS: salto, ventanaS: 0.01, pisoDb: -45};
		// publicado(t) = crudo(1.1 · t + 2.0)
		const pub: Envolvente = {db: Float64Array.from({length: 800}, (_, k) => patron(1.1 * (k * salto + 0.005) + 2.0)), saltoS: salto, ventanaS: 0.01, pisoDb: -45};
		const m = medirVelocidadTramo(crudo, pub, 0.5, 3.0, 1.1 * 0.5 + 2.0 - 0.06);
		expect(m.factor).toBeCloseTo(1.1, 2);
		expect(m.desfase).toBeCloseTo(2.0, 1);
		expect(m.r).toBeGreaterThan(0.95);
	});

	it('el resumen usa solo los tramos con r ≥ 0.8 y pondera por duración', () => {
		const v = resumirVelocidad([
			{p0: 0, p1: 4, factor: 1.1, desfase: 0, r: 0.95},
			{p0: 0, p1: 1, factor: 1.2, desfase: 0, r: 0.9},
			{p0: 0, p1: 10, factor: 1.5, desfase: 0, r: 0.3},
		]);
		expect(v.factor).toBe(1.1);
		expect(v.n).toBe(2);
		expect(v.probados).toBe(3);
		expect(resumirVelocidad([]).factor).toBeNull();
	});
});

describe('calibrar-cortes: reconstrucción de un par sintético (×1.1, una toma quitada y una pausa cortada)', () => {
	it('mide la velocidad con la que se aceleró', () => {
		expect(SUYA.velocidad.factor).not.toBeNull();
		expect(Math.abs((SUYA.velocidad.factor as number) - FACTOR)).toBeLessThanOrEqual(0.01);
		expect(SUYA.velocidad.n).toBeGreaterThanOrEqual(1);
	});

	it('encuentra los 2 cortes en el cuadro del salto y cuánto quitó cada uno', () => {
		expect(SUYA.cortes).toHaveLength(2);
		SUYA.cortes.forEach((c, k) => {
			expect(c.metodo).toBe('video');
			expect(c.cuadro).toBe(Math.round(CORTES_PUB[k] * 30));
			const quitado = KEEP_SUYO[k + 1].desde - KEEP_SUYO[k].hasta;
			expect(Math.abs(c.quitado_s - quitado)).toBeLessThanOrEqual(0.04);
		});
		expect(SUYA.cortes[0].tipo).toBe('palabras');
		expect(SUYA.cortes[1].tipo).toBe('pausa');
	});

	it('los tramos del crudo que se quedaron coinciden con la verdad (±1 cuadro del publicado)', () => {
		expect(SUYA.keep).toHaveLength(3);
		const tolerancia = FACTOR / 30 + 0.02;
		SUYA.keep.forEach((t, k) => {
			if (k > 0) expect(Math.abs(t.desde - KEEP_SUYO[k].desde)).toBeLessThanOrEqual(tolerancia);
			if (k < 2) expect(Math.abs(t.hasta - KEEP_SUYO[k].hasta)).toBeLessThanOrEqual(tolerancia);
		});
		expect(Math.abs(SUYA.duracionSinAcelerarS - KEEP_SUYO.reduce((s, t) => s + t.hasta - t.desde, 0))).toBeLessThanOrEqual(0.08);
	});

	it('la selección de palabras es la tuya: la toma 1 se fue y la 2 se quedó', () => {
		expect(SUYA.seleccion).toEqual(SELECCION_SUYA);
		expect(SUYA.publicadoSinReconstruir).toEqual([]);
		expect(SUYA.bloquesDescartados).toBe(0);
		const quitadas = SUYA.quitadas.filter((q) => q.tipo !== 'inicio' && q.tipo !== 'final');
		expect(quitadas).toHaveLength(1);
		expect(quitadas[0].texto).toBe('vas a hacer un');
		expect(['toma-repetida', 'arranque-en-falso']).toContain(quitadas[0].tipo);
	});

	it('pads: el silencio que dejaste a cada lado del corte de pausa (±1 cuadro)', () => {
		const pausa = SUYA.cortes[1];
		expect(pausa.pad_despues_s).not.toBeNull();
		expect(Math.abs((pausa.pad_despues_s as number) - PAD)).toBeLessThanOrEqual(FACTOR / 30 + 0.02);
		expect(Math.abs((pausa.pad_antes_s as number) - PAD)).toBeLessThanOrEqual(FACTOR / 30 + 0.02);
		// La pausa corta (0.2 s) se quedó y la larga (0.9 s) se cortó.
		const corta = SUYA.pausas.find((p) => Math.abs(p.duracion_s - 0.2) < 0.03);
		const larga = SUYA.pausas.find((p) => Math.abs(p.duracion_s - 0.9) < 0.03);
		expect(corta?.cortada).toBe(false);
		expect(larga?.cortada).toBe(true);
	});
});

describe('calibrar-cortes: rejilla', () => {
	// Una "edición tuya" hecha con construirKeep y parámetros conocidos: la rejilla tiene que reproducirla.
	const conocidos = {huecoMinimoS: 0.5, padAntesS: 0.06, padDespuesS: 0.1};
	const parametros = {...PARAMETROS_CORTES, ...conocidos};
	const seleccion = REALES.map(() => true);
	const r = construirKeep({limites: CRUDO.limites, seleccion, energia: CRUDO.energia, limiteS: CRUDO.duracionS, parametros});
	const fabricada: EdicionSuya = {...SUYA, keep: r.keep, seleccion, duracionSinAcelerarS: r.keep.reduce((s, t) => s + t.hasta - t.desde, 0)};
	const datos: DatosPar[] = [{par: 'sintético', crudo: CRUDO, suya: fabricada}];

	it('con esos mismos parámetros: F1 = 1 y error de duración 0', () => {
		const c = evaluarCombinacion(datos, PARAMETROS_CORTES, conocidos);
		expect(c.f1_medio).toBe(1);
		expect(c.error_medio_abs).toBe(0);
		expect(c.nivel).toBe(0);
	});

	it('la rejilla elige una combinación que reproduce la edición, y si empatan, la más cercana a la referencia', () => {
		const rejilla = {huecoMinimoS: [0.3, 0.5, 0.8], padAntesS: [0.02, 0.06, 0.12], padDespuesS: [0.04, 0.1, 0.15]};
		const {mejor, todas} = buscarParametros(datos, rejilla, PARAMETROS_CORTES, conocidos);
		expect(todas).toHaveLength(27);
		expect(mejor.f1_medio).toBe(1);
		expect(mejor.error_medio_abs).toBe(0);
		expect({huecoMinimoS: mejor.huecoMinimoS, padAntesS: mejor.padAntesS, padDespuesS: mejor.padDespuesS}).toEqual(conocidos);
	});

	it('elegirMejor: primero el nivel (±5 %), luego el F1', () => {
		const base = {por_par: [], error_max_abs: 0};
		const a = {...base, huecoMinimoS: 0.3, padAntesS: 0.08, padDespuesS: 0.12, f1_medio: 0.9, error_medio_abs: 0.1, nivel: 1 as const};
		const b = {...base, huecoMinimoS: 0.3, padAntesS: 0.04, padDespuesS: 0.04, f1_medio: 0.5, error_medio_abs: 0.01, nivel: 0 as const};
		expect(elegirMejor([a, b])).toBe(b);
		const c = {...b, f1_medio: 0.7, padAntesS: 0.1};
		expect(elegirMejor([b, c])).toBe(c);
	});

	it('tramos sin palabras: los de pura voz que cortes.ts conserva se cuentan aparte', () => {
		const limites = [{d: 1, h: 1.3}, {d: 5, h: 5.4}];
		const r = tramosSinPalabras([{desde: 0.9, hasta: 1.5}, {desde: 3, hasta: 3.2}, {desde: 4.9, hasta: 5.5}], [true, true], limites);
		expect(r).toEqual({n: 1, segundos: 0.2});
		expect(tramosSinPalabras([{desde: 4.9, hasta: 5.5}], [true, false], limites)).toEqual({n: 1, segundos: 0.6});
	});

	it('simularCortes da keep[] en cuadros y su duración', () => {
		const sim = simularCortes(CRUDO, PARAMETROS_CORTES, seleccion);
		expect(sim.cortes).toBe(sim.keep.length - 1);
		for (const b of bordesDe(sim.keep)) expect(Math.abs(b * 30 - Math.round(b * 30))).toBeLessThan(1e-6);
	});
});

describe('calibrar-cortes: regla de tomas y lo que quitaste', () => {
	it('la propuesta automática quita la toma 1 (se queda la última)', () => {
		const propuesta = seleccionPropuesta(CRUDO);
		for (let k = iC; k < iD; k++) expect(propuesta[k]).toBe(false);
		for (let k = iD; k <= fD; k++) expect(propuesta[k]).toBe(true);
	});

	it('buscarTomas no cambia la regla si ninguna mejora en al menos 2 pares sin quitar lo que dejaste', () => {
		const datos: DatosPar[] = [{par: 'sintético', crudo: CRUDO, suya: SUYA}];
		const r = buscarTomas(datos, {similitudMinima: [0.5, 0.6], cercaniaS: [10], pausaFraseS: [0.6], arranquePalabras: [3]});
		expect(r.mejor).toBe(r.porDefecto);
		expect(r.porDefecto.precision).toBe(1);
		expect(tomasDistintas({...OPCIONES_TOMAS, similitudMinima: 0.5})).toEqual({similitudMinima: 0.5});
		expect(tomasDistintas({})).toEqual({});
	});

	it('clasifica lo que quitaste: arranque en falso, relleno, palabra suelta, contenido, inicio y final', () => {
		const textos = 'bueno vas a vas a hacer esto mmm y luego páginas web chulísimas de verdad y otra cosa distinta que sigue aquí fin'.split(' ');
		let t = 0;
		const palabras = textos.map((w, i) => {
			const p = {i, t: w, d: t, h: t + 0.3};
			t += 0.4;
			return p;
		});
		const limites = palabras.map((p) => ({d: p.d, h: p.h}));
		const claves = palabras.map((p) => p.t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
		const quitar = new Set([0, 1, 2, 7, 11, 16, 17, 18, 22]);
		const seleccion = palabras.map((_, i) => !quitar.has(i));
		const q = clasificarQuitadas({palabras, limites, claves}, seleccion);
		const tipo = (texto: string) => q.find((x) => x.texto === texto)?.tipo;
		expect(tipo('bueno vas a')).toBe('inicio');
		expect(tipo('mmm')).toBe('relleno');
		expect(tipo('web')).toBe('palabra-suelta');
		expect(tipo('otra cosa distinta')).toBe('contenido');
		expect(tipo('fin')).toBe('final');
		const q2 = clasificarQuitadas({palabras, limites, claves}, palabras.map((_, i) => i !== 1 && i !== 2));
		expect(q2.find((x) => x.texto === 'vas a')?.tipo).toBe('arranque-en-falso');
	});
});

describe('calibrar-cortes: imágenes para revisar a ojo', () => {
	it('la línea de tiempo y la hoja de miniaturas son SVG con su texto escapado', () => {
		const svg = svgLineaDeTiempo('par <a&b>', 10, [{etiqueta: 'tu edición', tramos: [{desde: 1, hasta: 2}], color: '#2fbf71'}], [{d: 1, h: 1.5, quedo: true}]);
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('par &lt;a&amp;b&gt;');
		expect(svg).toContain('#2fbf71');
		const hoja = svgMiniaturas('saltos', [{jpegBase64: 'AAAA', etiqueta: 'c1\n«hola»'}], 2);
		expect(hoja).toContain('data:image/jpeg;base64,AAAA');
		expect(hoja).toContain('«hola»');
	});
});

// ───────────────────────── cortes.ts: voz ajena en la orilla de una palabra ─────────────────────────

describe('cortes.ts: whisper estira el final de una palabra hasta el arranque de la siguiente', () => {
	// «construye,» suena de 1.0 a 1.4; pausa de 0.25 s; «literalmente» arranca en 1.65 pero whisper la pone en 1.85 y
	// estira «construye,» hasta 1.75 (como en IMG_5199, 115.5–116.4 s). Luego «si quieres» en 4.0.
	const reales: Real[] = [
		{t: 'construye,', d: 1.0, h: 1.4, nivel: -20, f0: 120, silabas: 3},
		{t: 'literalmente', d: 1.65, h: 2.3, nivel: -21, f0: 130, silabas: 4},
		{t: 'el', d: 2.35, h: 2.5, nivel: -22, f0: 125, silabas: 1},
		{t: 'si', d: 4.0, h: 4.2, nivel: -20, f0: 115, silabas: 1},
		{t: 'quieres', d: 4.25, h: 4.6, nivel: -20, f0: 118, silabas: 2},
	];
	const wav = aWav(sintetizar(reales, 5.2, 21));
	const palabras: Palabra[] = [
		{i: 0, t: 'construye,', d: 0.99, h: 1.75},
		{i: 1, t: 'literalmente', d: 1.85, h: 2.33},
		{i: 2, t: 'el', d: 2.34, h: 2.52},
		{i: 3, t: 'si', d: 3.99, h: 4.24},
		{i: 4, t: 'quieres', d: 4.24, h: 4.85},
	];
	const energia = analizarEnergia(wav, palabras);
	const {limites} = refinarPalabras(energia, palabras);

	it('el final de «construye,» vuelve a donde suena (no a la voz de la palabra siguiente)', () => {
		expect(Math.abs(limites[0].h - 1.4)).toBeLessThanOrEqual(0.03);
		expect(limites[0].d).toBeCloseTo(1.0, 1);
	});

	it('al quitar «literalmente el», el corte no deja pasar su arranque (1.65 s) y la verificación sale limpia', () => {
		const seleccion = [true, false, false, true, true];
		const r = construirKeep({limites, seleccion, energia, limiteS: wav.duracionS});
		for (const t of r.keep) expect(t.hasta <= 1.65 + 1e-9 || t.desde >= 2.5 - 1e-9).toBe(true);
		const v = verificarCortes(r.keep, r.limites, seleccion);
		expect(v.dentroDePalabra).toHaveLength(0);
		expect(v.partidas).toHaveLength(0);
	});

	it('sin la regla (como antes) el final se iba hasta 1.75 s y el corte dejaba pasar el arranque de la palabra quitada', () => {
		const sinRegla = refinarPalabras(energia, palabras, {huecoS: Infinity, maxS: 0, fueraS: Infinity}).limites;
		expect(sinRegla[0].h).toBeGreaterThan(1.7);
		const r = construirKeep({limites: sinRegla, seleccion: [true, false, false, true, true], energia, limiteS: wav.duracionS});
		expect(r.keep.some((t) => t.desde < 1.7 && t.hasta > 1.7)).toBe(true);
	});

	it('voz sin palabras dentro de la palabra (que no sigue después del borde) no se toca', () => {
		const conColaPropia: Real[] = [
			{t: 'hola', d: 1.0, h: 1.3, nivel: -20, f0: 120, silabas: 2},
			{t: 'mmm', d: 1.5, h: 1.65, nivel: -24, f0: 140, silabas: 1},
			{t: 'adiós', d: 2.5, h: 2.9, nivel: -20, f0: 118, silabas: 2},
		];
		const w2 = aWav(sintetizar(conColaPropia, 3.4, 33));
		// whisper no escribió «mmm» y estiró «hola» hasta 1.75: esa voz queda dentro de «hola» (no sigue después de 1.75).
		const p2: Palabra[] = [
			{i: 0, t: 'hola', d: 0.99, h: 1.75},
			{i: 1, t: 'adiós', d: 2.49, h: 3.0},
		];
		const e2 = analizarEnergia(w2, p2);
		expect(refinarPalabras(e2, p2).limites[0].h).toBeGreaterThan(1.6);
	});
});

// ───────────────────────── cortes.ts lee la calibración ─────────────────────────

describe('cortes.ts: estilo/calibracion-cortes.json', () => {
	const raiz = mkdtempSync(join(tmpdir(), 'calibrar-cortes-'));
	afterAll(() => rmSync(raiz, {recursive: true, force: true}));
	const proyectos = join(raiz, 'proyectos');
	const estilo = join(raiz, 'estilo');
	mkdirSync(estilo, {recursive: true});
	const rutaCal = join(estilo, 'calibracion-cortes.json');

	it('busca el archivo junto a la carpeta de proyectos', () => {
		expect(rutaCalibracionCortes(proyectos)).toBe(rutaCal);
	});

	it('si no existe, devuelve null (mandan los valores por defecto)', () => {
		expect(leerCalibracionCortes(join(estilo, 'no-existe.json'))).toBeNull();
	});

	it('aplica solo lo calibrado encima de los valores por defecto y lista los cambios', () => {
		writeFileSync(rutaCal, JSON.stringify({version: 1, parametros: {padAntesS: 0.04, padDespuesS: 0.04, tomas: {similitudMinima: 0.5}}, n_pares: 4}));
		const c = leerCalibracionCortes(rutaCal);
		expect(c).not.toBeNull();
		expect(c!.parametros.padAntesS).toBe(0.04);
		expect(c!.parametros.padDespuesS).toBe(0.04);
		expect(c!.parametros.huecoMinimoS).toBe(PARAMETROS_CORTES.huecoMinimoS);
		expect(c!.parametros.tomas.similitudMinima).toBe(0.5);
		expect(c!.parametros.tomas.cercaniaS).toBe(OPCIONES_TOMAS.cercaniaS);
		expect(c!.parametros.guardiaS).toBe(PARAMETROS_CORTES.guardiaS);
		expect(c!.cambios).toEqual(['padAntesS 0.08 → 0.04', 'padDespuesS 0.12 → 0.04', 'tomas.similitudMinima 0.6 → 0.5']);
		expect(c!.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(aplicarCalibracion(PARAMETROS_CORTES, {}).huecoMinimoS).toBe(0.3);
	});

	it('un archivo roto o con valores fuera de rango sale con código 2', () => {
		const roto = join(estilo, 'roto.json');
		for (const contenido of ['{no es json', JSON.stringify({version: 1, parametros: {padAntesS: 5}}), JSON.stringify({version: 1, parametros: {otraCosa: 1}}), JSON.stringify({version: 2, parametros: {}})]) {
			writeFileSync(roto, contenido);
			expect(() => leerCalibracionCortes(roto)).toThrow(FalloEditor);
			try {
				leerCalibracionCortes(roto);
			} catch (e) {
				expect((e as FalloEditor).codigo).toBe(2);
				expect((e as FalloEditor).message).toMatch(/Siguiente paso:/);
			}
		}
	});

	it('ejecutarCortes usa la calibración (y la registra) y con calibracion: false usa los valores por defecto', async () => {
		const slug = '_prueba-calibrada';
		const dir = join(proyectos, slug);
		mkdirSync(dir, {recursive: true});
		escribirWav(join(dir, 'audio16k.wav'), WAV_CRUDO.muestras, FS);
		writeFileSync(join(dir, 'transcripcion.json'), JSON.stringify({metodo: 't_dtw', palabras: CRUDO.palabras.map((p) => ({...p, p: 0.9}))}));
		writeFileSync(rutaCal, JSON.stringify({version: 1, parametros: {padAntesS: 0.04, padDespuesS: 0.04}}));
		const vocabulario = join(raiz, 'vocabulario.json');
		writeFileSync(vocabulario, JSON.stringify({terminos: [], correcciones: {}}));

		const r = await ejecutarCortes({slug, proyectos, vocabulario});
		expect(r.calibracion?.archivo).toBe(rutaCal);
		const cortes = JSON.parse(readFileSync(join(dir, 'cortes.json'), 'utf8'));
		expect(cortes.parametros.padAntesS).toBe(0.04);
		expect(cortes.parametros.padDespuesS).toBe(0.04);
		expect(cortes.calibracion.sha256).toMatch(/^[0-9a-f]{64}$/);
		const entradas = leerManifest(slug, proyectos)?.etapas.cortes?.entradas.map((e) => e.ruta) ?? [];
		expect(entradas).toContain(rutaCal);

		const d = await ejecutarCortes({slug, proyectos, vocabulario, calibracion: false});
		expect(d.calibracion).toBeNull();
		const cortesDefecto = JSON.parse(readFileSync(join(dir, 'cortes.json'), 'utf8'));
		expect(cortesDefecto.parametros.padAntesS).toBe(PARAMETROS_CORTES.padAntesS);
		expect(cortesDefecto.calibracion.archivo).toBeNull();
		// Con pads más cerrados la base sale igual o más corta.
		expect(r.duracionBaseS).toBeLessThanOrEqual(d.duracionBaseS + 1e-9);
	});
});

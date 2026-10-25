// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/lib/remapear.ts: crudo ↔ base cortada, con tramos en cuadros de 30 fps.
 */
import {describe, expect, it} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {
	aCrudo,
	cuantizar,
	duracionBase,
	FPS,
	remapear,
	remapearIntervalo,
	validarKeep,
	type Tramo,
} from '../../herramientas/lib/remapear.ts';

const FORMATO = /^No pude [^:\n]+: [^\n]+\. Siguiente paso: [^\n]+\.$/;

/**
 * Crudo de 10 s con 3 tramos que se quedan:
 *   crudo [1, 2)   → base [0, 1)
 *   crudo [3, 5)   → base [1, 3)
 *   crudo [7.5, 8) → base [3, 3.5)
 */
const KEEP: Tramo[] = [
	{desde: 1, hasta: 2},
	{desde: 3, hasta: 5},
	{desde: 7.5, hasta: 8},
];

function capturar(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

/** Generador con semilla fija (mulberry32): las pruebas de propiedad siempre ven los mismos números. */
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

/** keep[] al azar: 25 tramos de 1 a 150 cuadros, con cortes de 1 a 90 cuadros entre ellos. */
function keepAlAzar(azar: () => number): Tramo[] {
	const keep: Tramo[] = [];
	let cuadro = Math.floor(azar() * 60);
	for (let i = 0; i < 25; i++) {
		const largo = 1 + Math.floor(azar() * 150);
		keep.push({desde: cuantizar(cuadro / FPS), hasta: cuantizar((cuadro + largo) / FPS)});
		cuadro += largo + 1 + Math.floor(azar() * 90);
	}
	return keep;
}

describe('cuantizar', () => {
	it('redondea al cuadro de 30 fps más cercano', () => {
		expect(cuantizar(0)).toBe(0);
		expect(cuantizar(1 / 30)).toBe(1 / 30);
		expect(cuantizar(0.016)).toBe(0); // 0.48 cuadros
		expect(cuantizar(0.017)).toBe(1 / 30); // 0.51 cuadros
		expect(cuantizar(1.234)).toBe(37 / 30); // 37.02 cuadros
		expect(cuantizar(0.05)).toBe(2 / 30); // 1.5 cuadros: la mitad sube
		expect(cuantizar(7.5)).toBe(7.5);
	});

	it('devuelve 0 y no -0 para tiempos negativos muy chicos', () => {
		expect(Object.is(cuantizar(-0.001), 0)).toBe(true);
	});

	it('es idempotente (con semilla fija)', () => {
		const azar = azarConSemilla(7);
		for (let n = 0; n < 200; n++) {
			const t = azar() * 300;
			expect(cuantizar(cuantizar(t))).toBe(cuantizar(t));
			expect(Math.abs(cuantizar(t) - t)).toBeLessThanOrEqual(0.5 / FPS + 1e-12);
		}
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY])('rechaza %s con código 1', (t) => {
		const error = capturar(() => cuantizar(t));
		expect(error.codigo).toBe(1);
		expect(error.message).toMatch(FORMATO);
	});
});

describe('validarKeep', () => {
	it('acepta tramos en orden, separados y en cuadros', () => {
		expect(() => validarKeep(KEEP)).not.toThrow();
		expect(() => validarKeep([{desde: cuantizar(1.234), hasta: cuantizar(5.678)}])).not.toThrow();
		// 0.1 + 0.2 = 0.30000000000000004: es el cuadro 9 con error de punto flotante, se acepta.
		expect(() => validarKeep([{desde: 0, hasta: 0.1 + 0.2}])).not.toThrow();
	});

	it.each<[string, unknown]>([
		['fuera de orden', [{desde: 3, hasta: 4}, {desde: 1, hasta: 2}]],
		['encimados', [{desde: 1, hasta: 3}, {desde: 2, hasta: 4}]],
		['pegados sin corte en medio', [{desde: 1, hasta: 2}, {desde: 2, hasta: 3}]],
		['un tramo de largo 0', [{desde: 1, hasta: 1}]],
		['un tramo al revés', [{desde: 2, hasta: 1}]],
		['un tramo antes del segundo 0', [{desde: -1, hasta: 1}]],
		['un borde fuera de cuadro (0.05 s = 1.5 cuadros)', [{desde: 0.05, hasta: 1}]],
		['vacío', []],
		['un borde NaN', [{desde: Number.NaN, hasta: 1}]],
		['un borde que no es número', [{desde: '1', hasta: 2}]],
		['un tramo null', [null]],
		['algo que no es lista', {desde: 1, hasta: 2}],
	])('rechaza keep[] %s con código 1', (_caso, keep) => {
		const error = capturar(() => validarKeep(keep as Tramo[]));
		expect(error.codigo).toBe(1);
		expect(error.message).toMatch(FORMATO);
	});

	it('si un borde no cae en cuadro, el mensaje dice que lo pases por cuantizar()', () => {
		const error = capturar(() => validarKeep([{desde: 0.05, hasta: 1}]));
		expect(error.message).toContain('cuantizar()');
	});

	it('todas las funciones validan keep[] antes de calcular', () => {
		const malo: Tramo[] = [{desde: 1, hasta: 3}, {desde: 2, hasta: 4}];
		expect(capturar(() => remapear(malo, 1.5)).codigo).toBe(1);
		expect(capturar(() => remapearIntervalo(malo, 1, 1.5)).codigo).toBe(1);
		expect(capturar(() => aCrudo(malo, 0)).codigo).toBe(1);
		expect(capturar(() => duracionBase(malo)).codigo).toBe(1);
	});
});

describe('duracionBase', () => {
	it('suma los tramos', () => {
		expect(duracionBase(KEEP)).toBe(3.5);
		expect(duracionBase([{desde: 0, hasta: 6}])).toBe(6);
	});
});

describe('remapear', () => {
	it.each<[number, number | null]>([
		[1, 0], // inicio del primer tramo
		[1.5, 0.5],
		[2, null], // `hasta` ya es el primer cuadro cortado
		[2.5, null], // dentro del corte
		[3, 1],
		[4.25, 2.25],
		[5, null],
		[7.5, 3],
		[7.75, 3.25],
		[8, null], // después del último tramo
		[0.5, null], // antes del primer tramo
		[9.99, null],
		[-1, null],
	])('crudo %s s → base %s', (t, esperado) => {
		const r = remapear(KEEP, t);
		if (esperado === null) expect(r).toBeNull();
		else expect(r).toBeCloseTo(esperado, 12);
	});

	it('justo antes del final de un tramo se queda en ese tramo', () => {
		const r = remapear(KEEP, 2 - 1e-9);
		expect(r).not.toBeNull();
		expect(r as number).toBeLessThan(1);
		expect(r as number).toBeCloseTo(1, 8);
	});

	it.each([Number.NaN, Number.NEGATIVE_INFINITY])('rechaza t = %s con código 1', (t) => {
		expect(capturar(() => remapear(KEEP, t)).codigo).toBe(1);
	});
});

describe('remapearIntervalo', () => {
	it('un intervalo dentro de un tramo se pasa tal cual', () => {
		const r = remapearIntervalo(KEEP, 1.25, 1.75);
		expect(r).toEqual({desde: 0.25, hasta: 0.75, tramo: 0});
	});

	it('un tramo completo da exactamente sus bordes en la base', () => {
		expect(remapearIntervalo(KEEP, 3, 5)).toEqual({desde: 1, hasta: 3, tramo: 1});
		expect(remapearIntervalo(KEEP, 7.5, 8)).toEqual({desde: 3, hasta: 3.5, tramo: 2});
	});

	it('recorta lo que se sale del tramo', () => {
		expect(remapearIntervalo(KEEP, 0.5, 1.5)).toEqual({desde: 0, hasta: 0.5, tramo: 0});
		expect(remapearIntervalo(KEEP, 4.5, 6)).toEqual({desde: 2.5, hasta: 3, tramo: 1});
	});

	it('si cruza un corte se queda con el tramo donde más dura', () => {
		// 0.25 s en el tramo 0 contra 0.125 s en el tramo 1
		expect(remapearIntervalo(KEEP, 1.75, 3.125)).toEqual({desde: 0.75, hasta: 1, tramo: 0});
		// 0.125 s en el tramo 0 contra 0.5 s en el tramo 1
		expect(remapearIntervalo(KEEP, 1.875, 3.5)).toEqual({desde: 1, hasta: 1.5, tramo: 1});
		// cubre todo: gana el tramo más largo (2 s)
		expect(remapearIntervalo(KEEP, 0, 10)).toEqual({desde: 1, hasta: 3, tramo: 1});
	});

	it('si empatan, gana el primero', () => {
		expect(remapearIntervalo(KEEP, 1.75, 3.25)).toEqual({desde: 0.75, hasta: 1, tramo: 0});
	});

	it.each<[number, number]>([
		[2.25, 2.75], // todo dentro de un corte
		[2, 3], // exactamente el corte
		[0, 0.5], // antes de todo
		[0.5, 1], // termina justo donde empieza el primer tramo
		[8, 9], // después de todo
	])('[%s, %s] no toca ningún tramo → null', (a, b) => {
		expect(remapearIntervalo(KEEP, a, b)).toBeNull();
	});

	it('un intervalo de largo 0 se trata como punto', () => {
		expect(remapearIntervalo(KEEP, 1.5, 1.5)).toEqual({desde: 0.5, hasta: 0.5, tramo: 0});
		expect(remapearIntervalo(KEEP, 2, 2)).toBeNull();
	});

	it('un intervalo al revés es un error interno, código 1', () => {
		const error = capturar(() => remapearIntervalo(KEEP, 1.8, 1.2));
		expect(error.codigo).toBe(1);
		expect(error.message).toMatch(FORMATO);
	});
});

describe('aCrudo', () => {
	it.each<[number, number]>([
		[0, 1],
		[0.5, 1.5],
		[1, 3], // el inicio del tramo 1 en la base es su inicio en el crudo
		[2.25, 4.25],
		[3, 7.5],
		[3.25, 7.75],
		[3.5, 8], // el final exacto de la base da el `hasta` del último tramo
	])('base %s s → crudo %s s', (tBase, esperado) => {
		expect(aCrudo(KEEP, tBase)).toBeCloseTo(esperado, 12);
	});

	it('en un borde de la base salta el corte: un pelo antes es el final del tramo anterior', () => {
		expect(aCrudo(KEEP, 1 - 1e-12)).toBeCloseTo(2, 9);
		expect(aCrudo(KEEP, 1 - 1e-12)).toBeLessThan(2);
		expect(aCrudo(KEEP, 1)).toBe(3);
	});

	it.each([-0.1, 3.6, Number.NaN])('rechaza %s (fuera de la base) con código 1', (tBase) => {
		const error = capturar(() => aCrudo(KEEP, tBase));
		expect(error.codigo).toBe(1);
		expect(error.message).toMatch(FORMATO);
	});
});

describe('propiedades con semilla fija', () => {
	const azar = azarConSemilla(20261003);
	const keep = keepAlAzar(azar);
	const total = duracionBase(keep);

	it('duracionBase es la suma de los largos', () => {
		const suma = keep.reduce((s, tr) => s + (tr.hasta - tr.desde), 0);
		expect(total).toBeCloseTo(suma, 9);
		expect(Math.round(total * FPS)).toBeCloseTo(total * FPS, 9); // la base dura un número entero de cuadros
	});

	it('remapear(aCrudo(t)) ≈ t para 200 tiempos de la base al azar', () => {
		for (let n = 0; n < 200; n++) {
			const t = azar() * total;
			const vuelta = remapear(keep, aCrudo(keep, t));
			expect(vuelta).not.toBeNull();
			expect(Math.abs((vuelta as number) - t)).toBeLessThan(1e-9);
		}
	});

	it('aCrudo(remapear(t)) ≈ t para 200 tiempos del crudo dentro de los tramos', () => {
		for (let n = 0; n < 200; n++) {
			const tr = keep[Math.floor(azar() * keep.length)];
			const t = tr.desde + azar() * (tr.hasta - tr.desde);
			const base = remapear(keep, t);
			expect(base).not.toBeNull();
			expect(Math.abs(aCrudo(keep, base as number) - t)).toBeLessThan(1e-9);
		}
	});

	it('200 tiempos del crudo dentro de los cortes dan null', () => {
		for (let n = 0; n < 200; n++) {
			const i = Math.floor(azar() * (keep.length - 1));
			const t = keep[i].hasta + azar() * (keep[i + 1].desde - keep[i].hasta);
			expect(remapear(keep, t)).toBeNull();
		}
	});

	it('el orden se conserva: más tarde en el crudo es más tarde en la base', () => {
		const tiempos = Array.from({length: 200}, () => {
			const tr = keep[Math.floor(azar() * keep.length)];
			return tr.desde + azar() * (tr.hasta - tr.desde);
		}).sort((x, y) => x - y);
		const enBase = tiempos.map((t) => remapear(keep, t) as number);
		for (let i = 1; i < enBase.length; i++) expect(enBase[i]).toBeGreaterThanOrEqual(enBase[i - 1]);
	});

	it('cada borde de keep[] cae donde debe: inicio exacto y `hasta` cortado', () => {
		// Los bordes de la base se calculan en cuadros enteros, igual que el módulo: sumar segundos
		// deja el borde 1e-15 s antes, y eso ya es el final del tramo anterior.
		let cuadrosInicio = 0;
		keep.forEach((tr, i) => {
			const cuadrosFin = cuadrosInicio + Math.round((tr.hasta - tr.desde) * FPS);
			const inicio = cuadrosInicio / FPS;
			const fin = cuadrosFin / FPS;
			expect(remapear(keep, tr.desde)).toBe(inicio);
			expect(aCrudo(keep, inicio)).toBe(tr.desde);
			expect(remapear(keep, tr.hasta)).toBeNull();
			expect(remapearIntervalo(keep, tr.desde, tr.hasta)).toEqual({desde: inicio, hasta: fin, tramo: i});
			expect(duracionBase(keep.slice(0, i + 1))).toBe(fin);
			cuadrosInicio = cuadrosFin;
		});
	});

	it('un intervalo al azar dentro de un tramo conserva su largo y su inicio', () => {
		for (let n = 0; n < 200; n++) {
			const i = Math.floor(azar() * keep.length);
			const tr = keep[i];
			const a = tr.desde + azar() * (tr.hasta - tr.desde);
			const b = a + azar() * (tr.hasta - a);
			const r = remapearIntervalo(keep, a, b);
			expect(r).not.toBeNull();
			expect(r?.tramo).toBe(i);
			expect(Math.abs((r?.desde ?? Number.NaN) - (remapear(keep, a) as number))).toBeLessThan(1e-9);
			expect(Math.abs((r?.hasta ?? Number.NaN) - (r?.desde ?? Number.NaN) - (b - a))).toBeLessThan(1e-9);
		}
	});
});
